import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import saveData from '../src/saveData.mjs'
import syncData from '../src/syncData.mjs'
import { readGaps, openGapStore } from '../src/gaps.mjs'
import timers from '../src/timers.mjs'
import { install, setNow, uninstall } from './tools/fakeClock.mjs'


ot.extend(utc)
ot.extend(timezone)


//規格: sgud/rule/rulebook.md W13(重試)、W14(分類與可達之判定)、W15(標註、紀錄檔、完整性、手動重置)、W16(回傳之failed、gaps、items[].reason, aggregate.missing之cause)
//假交易所 + 假時鐘(「現在」與檔案修改時間皆為注入之時刻) + 注入之計時器(重試之等待只記錄不真的等)

let H = 3600 * 1000
let D = 24 * H
let iv = 4 * H
let fdRoot = './test/_tmp/api-saveDataGaps'

//T0, 測試之「現在」: 2026-02-02T06:00Z; 4hr(UTC)自 dayStart 2026-01-25 起每段 8 天 ⇒ 段0(01-25~02-02, 舊段)、段1(02-02~02-10, 最新段); 各案只把時鐘推進至 02-09 前, 最新段不變
let T0 = Date.parse('2026-02-02T06:00:00Z')
let dayStart = '2026-01-25'
let S0 = Date.parse('2026-01-25T00:00:00Z')
let segStart = (k) => S0 + k * 8 * D
let fmt = (ms) => ot.tz(ms, 'UTC').format('YYYY-MM-DDTHH:mm:ss')
let tagOf = (k) => ot.tz(segStart(k), 'UTC').format('YYYYMMDDHHmmss')
let iso = (ms) => new Date(ms).toISOString()
let fdOf = (name, folder = '4hr') => path.resolve(fdRoot, name, 'price', folder)
let fpOf = (name, k) => `${fdOf(name)}/${tagOf(k)}.csv`
let gpOf = (name) => `${fdOf(name)}/_gaps.json` //紀錄檔: 每資料夾一個, 與分段CSV同夾
let readJson = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'))
let rowsOf = (fp) => fs.readFileSync(fp, 'utf8').split('\n')
let GAP = S0 + 10 * iv //段0之第10根(2026-01-26T16:00Z)

//假交易所之狀態(每案重設)
let mode = null
let resetMode = () => {
    mode = {
        drop: new Set(), //不回傳之根(開盤毫秒)
        listing: 0, //早於此之根不回傳(上市前)
        fail: new Map(), //startTime -> 失敗之回應(每次請求皆同)
        failAll: null, //所有K線請求之失敗回應
        time: { status: 200 }, //時間端點之回應, 未給body時回 { serverTime: 現在 }
        onKlines: null, //收到K線請求時之回呼
    }
}
let reqs = [] //收到之請求: K線為 startTime, 時間端點為 'time <路徑>'
let hung = []
let waits = []
let sleepReal = timers.sleep

//barOf, 各根之值逐根相異(由開盤毫秒導出)
let barOf = (o) => {
    let k = Math.round(o / iv) % 100000
    return [o, `${k}.1`, `${k}.7`, `${k}.0`, `${k}.3`, `${k}.05`, o + iv - 1, `${k}.2`, k + 7, `${k}.01`, `${k}.02`, '0']
}
let barsOf = (ex, s, e) => {
    let d = ex === '8h' ? 2 * iv : iv
    let rs = []
    for (let o = Math.ceil(s / d) * d; o <= e && o <= Date.now(); o += d) {
        if (mode.drop.has(o) || o < mode.listing) {
            continue
        }
        let r = barOf(o)
        r[6] = o + d - 1
        rs.push(r)
    }
    return rs
}

let reply = (req, res, f) => {
    if (f.hang) {
        hung.push(res)
        return
    }
    if (f.destroy) {
        req.socket.destroy()
        return
    }
    let body = f.body === undefined ? 'error' : f.body
    res.writeHead(f.status, { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json', ...(f.headers || {}) })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

let server = null
let port = 0
let ep = () => `http://127.0.0.1:${port}/api/v3/klines`

let run = (name, opt = {}, interval = '4hr', endpoint = ep()) => {
    reqs = []
    waits = []
    return saveData(name, 'price', endpoint, 'TESTUSDT', interval, {
        dayStart,
        timeZone: 'UTC',
        fdData: fdRoot,
        ...opt,
    })
}

//listTree, 資料夾內之檔名
let listTree = (fd) => (fs.existsSync(fd) ? fs.readdirSync(fd).sort() : [])

//putOut, 於資料夾之紀錄檔加入期間外(dayStart 之前之段, tag 20260117000000)一根之暫無數據
let putOut = (name, o) => {
    let gs = openGapStore(fdOf(name), { interval: '4hr', timeZone: 'UTC' })
    gs.barsOf('20260117000000').set(o, { state: 'pending', validCount: 1, firstValid: T0, lastValid: T0, lastKind: 'missing', lastHttpStatus: 200, lastCode: null, uncounted: 0, lastUncountedKind: null, markedAt: null })
    gs.touch('20260117000000')
    gs.save()
}

//spyGap, 執行 f 期間記錄對紀錄檔之讀(fs.readFileSync)次數、寫暫存檔(fp + '.<pid>.tmp')次數、改名為紀錄檔次數、直接寫紀錄檔次數; result 為 f 之結果
let spyGap = async (fp, f) => {
    let st = { reads: 0, writes: 0, renames: 0, direct: 0, result: null }
    let rf = fs.readFileSync
    let wf = fs.writeFileSync
    let rn = fs.renameSync
    let same = (p) => path.resolve(String(p)) === path.resolve(fp)
    let tmp = (p) => path.resolve(String(p)).startsWith(`${path.resolve(fp)}.`) && path.resolve(String(p)).endsWith('.tmp')
    fs.readFileSync = (p, ...args) => {
        if (same(p)) {
            st.reads++
        }
        return rf(p, ...args)
    }
    fs.writeFileSync = (p, ...args) => {
        if (same(p)) {
            st.direct++
        }
        if (tmp(p)) {
            st.writes++
        }
        return wf(p, ...args)
    }
    fs.renameSync = (a, b, ...args) => {
        if (same(b) && tmp(a)) {
            st.renames++
        }
        return rn(a, b, ...args)
    }
    try {
        st.result = await f()
    }
    finally {
        fs.readFileSync = rf
        fs.writeFileSync = wf
        fs.renameSync = rn
    }
    return st
}

//rangeOf, 段0之GAP一根之紀錄(範圍帶所屬分段之tag)
let rangeOf = (o) => ({ tag: tagOf(0), from: fmt(GAP), to: fmt(GAP), n: 1, state: 'pending', validCount: 1, firstValid: iso(T0), lastValid: iso(T0), lastKind: 'missing', lastHttpStatus: 200, lastCode: null, uncounted: 0, lastUncountedKind: null, markedAt: null, ...o })


describe('api-saveDataGaps', function() {

    before(async function() {
        install(T0)
        timers.sleep = async (ms) => {
            waits.push(ms)
        }
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
        server = http.createServer((req, res) => {
            let u = new URL(req.url, 'http://127.0.0.1')
            if (!u.pathname.endsWith('/klines') && !u.pathname.endsWith('/time')) {
                //路徑有誤(例: '/api/v3/klinez'): 一律 404
                reqs.push(`404 ${u.pathname}`)
                reply(req, res, { status: 404, body: '<html>Not Found</html>' })
                return
            }
            if (u.pathname.endsWith('/time')) {
                reqs.push(`time ${u.pathname}`)
                let f = mode.time
                reply(req, res, { ...f, body: f.body === undefined ? { serverTime: Date.now() } : f.body })
                return
            }
            let s = Number(u.searchParams.get('startTime'))
            let e = Number(u.searchParams.get('endTime'))
            reqs.push(s)
            if (mode.onKlines) {
                mode.onKlines(s)
            }
            let f = mode.failAll || mode.fail.get(s)
            if (f) {
                reply(req, res, f)
                return
            }
            reply(req, res, { status: 200, body: barsOf(u.searchParams.get('interval'), s, e) })
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        port = server.address().port
    })

    beforeEach(function() {
        setNow(T0)
        resetMode()
    })

    afterEach(function() {
        for (let res of hung) {
            res.destroy()
        }
        hung = []
    })

    after(async function() {
        uninstall()
        timers.sleep = sleepReal
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(fdRoot, { recursive: true, force: true })
        let fdTmp = path.dirname(path.resolve(fdRoot))
        try {
            if (fs.existsSync(fdTmp) && fs.readdirSync(fdTmp).length === 0) {
                fs.rmdirSync(fdTmp)
            }
        }
        catch (err) {
            if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT') {
                throw err
            }
        }
    })

    it('S1 請求皆成功且無缺根: 不新增任何檔(只有分段CSV)、回傳只有既有三鍵、不請求時間端點', async function() {
        //W15: 紀錄檔只在有暫無數據或已標註之根時存在; W16: failed、gaps 只在非空時出現
        let r = await run('S1')
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0)])
        assert.deepStrictEqual(Object.keys(r), ['timeKeep', 'timeLast', 'items'])
        assert.deepStrictEqual(listTree(fdOf('S1')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`])
        setNow(T0 + D)
        r = await run('S1')
        assert.deepStrictEqual(reqs, [segStart(1)])
        assert.deepStrictEqual(Object.keys(r), ['timeKeep', 'timeLast', 'items'])
        assert.deepStrictEqual(listTree(fdOf('S1')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`])
    })

    it('S2 交易所缺根: 第1次記為暫無數據(紀錄檔之內容); 每次執行皆重抓(pending); 3次而未滿7天不標註; 滿7天之第4次標註; 其後不再請求該段', async function() {
        //W15: 標註 = 有效觀察 ≥ 3 且首末相隔 ≥ 7 天(且於有效觀察之當下); 標註後之段為完整(分段CSV之根 + 已標註之根 = 應有之根)而不再抓
        mode.drop.add(GAP)
        let r = await run('S2')
        assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [[tagOf(1), 'latest'], [tagOf(0), 'notExist']])
        assert.strictEqual(rowsOf(fpOf('S2', 0)).length, 47)
        assert.deepStrictEqual(readJson(gpOf('S2')), { v: 1, interval: '4hr', timeZone: 'UTC', ranges: [rangeOf({})] })
        assert.deepStrictEqual(r.gaps, [rangeOf({})])
        assert.strictEqual(r.failed, undefined)
        //紀錄檔每資料夾一個(與分段CSV同夾), 不是每段一個
        assert.deepStrictEqual(listTree(fdOf('S2')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`, '_gaps.json'])
        //同一次執行至多 1 次: 同一時刻再執行亦為另一次執行(計 1 次)
        setNow(T0 + 3 * D)
        r = await run('S2')
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0)])
        assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [[tagOf(1), 'latest'], [tagOf(0), 'pending']])
        assert.deepStrictEqual(r.gaps, [rangeOf({ validCount: 2, lastValid: iso(T0 + 3 * D) })])
        setNow(T0 + 7 * D - H)
        r = await run('S2')
        assert.deepStrictEqual(r.gaps.map((v) => [v.state, v.validCount, v.markedAt]), [['pending', 3, null]])
        setNow(T0 + 7 * D)
        r = await run('S2')
        assert.deepStrictEqual(r.gaps, [rangeOf({ state: 'nodata', validCount: 4, lastValid: iso(T0 + 7 * D), markedAt: iso(T0 + 7 * D) })])
        //標註後: 段0不再請求、不在items; 分段CSV不變; readGaps與回傳之gaps相同
        let c0 = fs.readFileSync(fpOf('S2', 0), 'utf8')
        setNow(T0 + 7 * D + H)
        r = await run('S2')
        assert.deepStrictEqual(reqs, [segStart(1)])
        assert.deepStrictEqual(r.items.map((v) => v.tag), [tagOf(1)])
        assert.strictEqual(fs.readFileSync(fpOf('S2', 0), 'utf8'), c0)
        assert.deepStrictEqual(readGaps(fdRoot, 'S2', 'price', '4hr'), r.gaps)
        assert.strictEqual(r.gaps[0].state, 'nodata')
    })

    it('S3 邊界: 有效觀察2次即使相隔滿7天不標註, 第3次才標註', async function() {
        //W15 條件1(次數)
        mode.drop.add(GAP)
        await run('S3')
        setNow(T0 + 7 * D)
        let r = await run('S3')
        assert.deepStrictEqual(r.gaps.map((v) => [v.state, v.validCount]), [['pending', 2]])
        setNow(T0 + 7 * D + H)
        r = await run('S3')
        assert.deepStrictEqual(r.gaps.map((v) => [v.state, v.validCount, v.markedAt]), [['nodata', 3, iso(T0 + 7 * D + H)]])
    })

    it('S4 邊界: 最近一次嘗試為不算觀察(斷線)時不標註; 不算觀察列入failed(counted false)並累計uncounted; 其後之有效觀察才標註', async function() {
        //W15 條件3; W14: 連線錯誤不算觀察
        mode.drop.add(GAP)
        await run('S4')
        setNow(T0 + D)
        await run('S4')
        setNow(T0 + 2 * D)
        await run('S4')
        setNow(T0 + 7 * D)
        mode.fail.set(segStart(0), { destroy: true })
        let r = await run('S4')
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0), segStart(0), segStart(0), segStart(0)])
        assert.deepStrictEqual(waits, [1000, 3000, 9000])
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.attempts, v.counted]), [[tagOf(0), 'network', 4, false]])
        assert.deepStrictEqual(r.gaps, [rangeOf({ validCount: 3, lastValid: iso(T0 + 2 * D), uncounted: 1, lastUncountedKind: 'network' })])
        mode.fail.clear()
        setNow(T0 + 7 * D + H)
        r = await run('S4')
        assert.deepStrictEqual(r.gaps.map((v) => [v.state, v.validCount, v.uncounted, v.markedAt]), [['nodata', 4, 1, iso(T0 + 7 * D + H)]])
    })

    it('S5 清零: 暫無數據之根其後取得即刪除紀錄(紀錄檔刪除、gaps不出現)', async function() {
        //W15: 任何一次嘗試取得該根 ⇒ 刪除該根之紀錄
        mode.drop.add(GAP)
        await run('S5')
        setNow(T0 + 2 * D)
        await run('S5')
        mode.drop.clear()
        setNow(T0 + 7 * D + H)
        let r = await run('S5')
        assert.strictEqual(fs.existsSync(gpOf('S5')), false)
        assert.strictEqual(r.gaps, undefined)
        assert.strictEqual(rowsOf(fpOf('S5', 0)).length, 48)
        assert.strictEqual(rowsOf(fpOf('S5', 0))[10].slice(0, 19), fmt(GAP))
        //之後再缺: 重新自第1次累計
        mode.drop.add(GAP)
        fs.rmSync(fpOf('S5', 0))
        r = await run('S5')
        assert.deepStrictEqual(r.gaps.map((v) => [v.state, v.validCount, v.firstValid]), [['pending', 1, iso(T0 + 7 * D + H)]])
    })

    it('S6 手動重置: useResetGaps 為 true 時先刪除期間內各分段之紀錄後重新累計(乾跑不刪); 或刪除紀錄檔', async function() {
        //W15 手動重置
        mode.drop.add(GAP)
        let r = await run('S6', { noDataTimes: 1, timeNoData: 0 })
        assert.strictEqual(r.gaps[0].state, 'nodata')
        r = await run('S6')
        assert.deepStrictEqual(reqs, [segStart(1)])
        r = await run('S6', { useResetGaps: true, useDryRun: true })
        assert.strictEqual(readJson(gpOf('S6')).ranges[0].state, 'nodata')
        assert.deepStrictEqual(r.items.map((v) => v.tag), [tagOf(1)])
        setNow(T0 + D)
        r = await run('S6', { useResetGaps: true })
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0)])
        assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [[tagOf(1), 'latest'], [tagOf(0), 'count']])
        assert.deepStrictEqual(r.gaps.map((v) => [v.state, v.validCount, v.firstValid]), [['pending', 1, iso(T0 + D)]])
        //刪除紀錄檔: 段0回到未觀察(筆數不符而重抓), 重新累計
        fs.rmSync(gpOf('S6'))
        setNow(T0 + 2 * D)
        r = await run('S6')
        assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [[tagOf(1), 'latest'], [tagOf(0), 'count']])
        assert.deepStrictEqual(r.gaps.map((v) => [v.validCount, v.firstValid]), [[1, iso(T0 + 2 * D)]])
    })

    it('S7 上市前之整段(回應為空陣列): 各根為暫無數據, 標註後無分段CSV亦為完整而不再請求', async function() {
        //W15: 整段皆已標註者無分段檔亦完整; 最新段內上市前之根亦記錄
        mode.listing = segStart(1) + 2 * iv
        let r = await run('S7')
        assert.strictEqual(fs.existsSync(fpOf('S7', 0)), false)
        //同一個紀錄檔內: 舊段整段(48根)一個範圍; 最新段已收棒加寬限者(00:00 一根)記錄, 尚未收棒者(04:00)不記; 兩段之範圍各帶所屬 tag, 不因相鄰而合併
        assert.deepStrictEqual(readJson(gpOf('S7')).ranges.map((v) => [v.tag, v.from, v.to, v.n, v.state]), [[tagOf(0), fmt(segStart(0)), fmt(segStart(1) - iv), 48, 'pending'], [tagOf(1), fmt(segStart(1)), fmt(segStart(1)), 1, 'pending']])
        setNow(T0 + H)
        r = await run('S7')
        assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [[tagOf(1), 'latest'], [tagOf(0), 'pending']])
        r = await run('S7', { noDataTimes: 1, timeNoData: 0 })
        assert.deepStrictEqual(r.gaps.map((v) => [v.tag, v.n, v.state]), [[tagOf(0), 48, 'nodata'], [tagOf(1), 1, 'nodata']])
        setNow(T0 + 2 * H)
        r = await run('S7')
        assert.deepStrictEqual(reqs, [segStart(1)])
        assert.strictEqual(fs.existsSync(fpOf('S7', 0)), false)
    })

    it('S8 錯誤回應之分類: 同一K線端點於本次對別段回過2xx陣列時5xx為有效觀察; 只下載單一分段而回5xx不計; 不請求時間端點', async function() {
        //W14: 4xx/5xx(400、403、418、429除外)只在同一K線端點於本次執行對別的分段回過2xx陣列時為有效觀察(httpError)
        mode.fail.set(segStart(0), { status: 503, body: { code: -1001, msg: 'x' } })
        let r = await run('S8a')
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0), segStart(0), segStart(0), segStart(0)])
        assert.deepStrictEqual(r.failed, [{ tag: tagOf(0), ts: fmt(segStart(0)), te: fmt(segStart(1) - 1000), kind: 'httpError', httpStatus: 503, code: -1001, attempts: 4, counted: true }])
        assert.deepStrictEqual(readJson(gpOf('S8a')).ranges.map((v) => [v.n, v.state, v.validCount, v.lastKind, v.lastHttpStatus, v.lastCode]), [[48, 'pending', 1, 'httpError', 503, -1001]])
        //只下載單一分段(dayStart 為最新段之起點)而該段回5xx: 本次無任何2xx陣列 ⇒ 不計(不寫紀錄檔), 不加打時間端點
        mode.fail.clear()
        mode.fail.set(segStart(1), { status: 500 })
        for (let t of [T0, T0 + 4 * D, T0 + 7 * D + H]) {
            setNow(t)
            r = await run('S8b', { dayStart: '2026-02-02' })
            assert.deepStrictEqual(reqs, [segStart(1), segStart(1), segStart(1), segStart(1)])
            assert.deepStrictEqual(r.failed.map((v) => [v.kind, v.httpStatus, v.counted]), [['httpError', 500, false]])
            assert.deepStrictEqual(listTree(fdOf('S8b')), [])
        }
        //既有之暫無數據於只下載單一分段而回5xx時: 只累計uncounted
        mode.fail.clear()
        setNow(T0)
        mode.drop.add(segStart(1))
        await run('S8c', { dayStart: '2026-02-02' })
        mode.fail.set(segStart(1), { status: 502 })
        setNow(T0 + 7 * D + H)
        r = await run('S8c', { dayStart: '2026-02-02' })
        assert.deepStrictEqual(r.gaps.map((v) => [v.from, v.state, v.validCount, v.uncounted, v.lastUncountedKind]), [[fmt(segStart(1)), 'pending', 1, 1, 'httpError']])
    })

    it('S8x 端點路徑有誤(一律404)經7天多次執行不產生任何紀錄; 改正路徑後各段照常下載', async function() {
        //W14: 本次無任何2xx陣列回應之4xx不算觀察 ⇒ 設定錯誤不會把整段期間標為缺根
        let epBad = `http://127.0.0.1:${port}/api/v3/klinez`
        for (let t of [T0, T0 + 3.5 * D, T0 + 7 * D, T0 + 7 * D + H]) {
            setNow(t)
            let r = await run('S8x', {}, '4hr', epBad)
            assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.httpStatus, v.attempts, v.counted]), [[tagOf(1), 'httpError', 404, 1, false], [tagOf(0), 'httpError', 404, 1, false]])
            assert.deepStrictEqual(reqs, ['404 /api/v3/klinez', '404 /api/v3/klinez'])
            assert.strictEqual(r.gaps, undefined)
            assert.deepStrictEqual(listTree(fdOf('S8x')), [])
        }
        let r = await run('S8x')
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0)])
        assert.strictEqual(r.failed, undefined)
        assert.deepStrictEqual(listTree(fdOf('S8x')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`])
    })

    it('S9 不算觀察之類: 400(參數錯誤, 不重試)、403、HTTP 200 而非陣列、連線錯誤 —— 經7天多次執行亦不寫紀錄、不標註', async function() {
        //W14: badRequest、blocked、invalidResponse、network 不算觀察
        let cases = [
            ['S9a', { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } }, 'badRequest', 1],
            ['S9b', { status: 403, body: '<html>waf</html>' }, 'blocked', 4],
            ['S9c', { status: 200, body: '<html>challenge</html>' }, 'invalidResponse', 4],
            ['S9d', { destroy: true }, 'network', 4],
            ['S9e', { status: 302, body: '<html>moved</html>' }, 'httpError', 1], //非 4xx/5xx 之非 2xx(轉址頁面): 不算觀察、不重試
        ]
        for (let [name, f, kind, attempts] of cases) {
            for (let t of [T0, T0 + 3 * D, T0 + 7 * D + H]) {
                setNow(t)
                mode.fail.set(segStart(0), f)
                let r = await run(name)
                assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.attempts, v.counted]), [[tagOf(0), kind, attempts, false]], name)
                assert.strictEqual(reqs.filter((v) => v === segStart(0)).length, attempts, name)
                assert.deepStrictEqual(listTree(fdOf(name)), [`${tagOf(1)}.csv`], name)
                assert.strictEqual(r.gaps, undefined, name)
            }
        }
        //400 之 code 記於 failed
        mode.fail.set(segStart(0), cases[0][1])
        assert.deepStrictEqual((await run('S9a')).failed[0].code, -1121)
    })

    it('S10 斷線一整段期間(所有請求皆失敗)不得被標註: 既有之暫無數據只累計uncounted; 未觀察過之根不新增紀錄', async function() {
        //W14、W15: 不算觀察不改有效觀察之次數與時刻
        mode.drop.add(GAP)
        await run('S10')
        mode.failAll = { destroy: true }
        for (let t of [T0 + D, T0 + 3 * D, T0 + 5 * D, T0 + 7 * D + H]) {
            setNow(t)
            let r = await run('S10')
            assert.ok(r.failed.every((v) => v.counted === false && v.kind === 'network'))
            assert.ok(reqs.every((v) => typeof v === 'number'))
        }
        assert.deepStrictEqual(readGaps(fdRoot, 'S10', 'price', '4hr').map((v) => [v.state, v.validCount, v.lastValid, v.uncounted]), [['pending', 1, iso(T0), 4]])
        //全新之資料夾於斷線期間: 不寫任何檔(既無分段CSV亦無紀錄檔)
        setNow(T0)
        await run('S10b')
        setNow(T0 + 7 * D + H)
        let r = await run('S10b')
        assert.deepStrictEqual(listTree(fdOf('S10b')), [])
        assert.strictEqual(r.gaps, undefined)
        //全部段皆回5xx(本次無任何2xx陣列)經7天亦不標註
        mode.failAll = { status: 502 }
        mode.time = { status: 502 }
        for (let t of [T0, T0 + 4 * D, T0 + 7 * D + H]) {
            setNow(t)
            await run('S10c')
        }
        assert.deepStrictEqual(listTree(fdOf('S10c')), [])
    })

    it('S11 418 後停止本次執行之後續請求(不重試、舊段不請求、不請求時間端點); 429 之 Retry-After 超過上限亦同', async function() {
        //W13: 418 或 429 超過上限 ⇒ 本次執行停止送出後續請求, 未處理之段記為未問到
        mode.fail.set(segStart(1), { status: 418, body: { code: -1003 }, headers: { 'Retry-After': '30' } })
        let r = await run('S11')
        assert.deepStrictEqual(reqs, [segStart(1)])
        assert.deepStrictEqual(r.items.map((v) => v.tag), [tagOf(1), tagOf(0)])
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.httpStatus, v.attempts, v.counted]), [[tagOf(1), 'banned', 418, 1, false], [tagOf(0), 'banned', null, 0, false]])
        assert.deepStrictEqual(listTree(fdOf('S11')), [])
        mode.fail.set(segStart(1), { status: 429, body: { code: -1003 }, headers: { 'Retry-After': '61' } })
        r = await run('S11')
        assert.deepStrictEqual(reqs, [segStart(1)])
        assert.deepStrictEqual(r.failed.map((v) => [v.kind, v.attempts]), [['rateLimited', 1], ['rateLimited', 0]])
        //Retry-After 不超過上限: 依之等待後重試成功, 不停止
        let n = 0
        mode.fail.clear()
        mode.onKlines = (s) => {
            if (s === segStart(1) && n++ === 0) {
                mode.fail.set(s, { status: 429, body: {}, headers: { 'Retry-After': '2' } })
            }
            else {
                mode.fail.delete(s)
            }
        }
        r = await run('S11')
        assert.deepStrictEqual(reqs, [segStart(1), segStart(1), segStart(0)])
        assert.deepStrictEqual(waits, [2000])
        assert.strictEqual(r.failed, undefined)
    })

    it('S12 逾時: 不回應之分段於timeRequest後列為timeout(不算觀察), 其餘分段照常', async function() {
        //W13 逾時; W14: 逾時不算觀察
        mode.drop.add(GAP)
        await run('S12')
        mode.fail.set(segStart(0), { hang: true })
        setNow(T0 + D)
        let r = await run('S12', { timeRequest: 200, retryTimes: 1 })
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0), segStart(0)])
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.attempts, v.counted]), [[tagOf(0), 'timeout', 2, false]])
        assert.deepStrictEqual(r.gaps.map((v) => [v.validCount, v.uncounted, v.lastUncountedKind]), [[1, 1, 'timeout']])
    })

    it('S13 合併: 基底第一段請求失敗之目標根列為 unobserved(修正: 不再當成上市前); 基底暫無數據之目標根 cause pending, 標註後 nodata; 回傳附基底之 failed 與 gaps', async function() {
        //W16: aggregate.missing 之 cause; 修正 —— 基底第一段失敗時其目標根列入
        //1day(台北)由 8hr 合併: 基底每段 16 天, dayStart 2026-01-01 ⇒ 基底段 j0、j1、j2(最新)
        let tz = 'Asia/Taipei'
        let ds = '2026-01-01'
        let t0 = ot.tz(`${ds}T00:00:00`, tz).valueOf()
        let b0 = t0 //j0 之起點 = startTime
        let fmtL = (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')
        let dropDay = t0 + 20 * D //j1 內之一日(當地)之第2根8h不回傳
        mode.drop.add(dropDay + 8 * H)
        mode.fail.set(b0, { destroy: true })
        let r = await run('S13', { dayStart: ds, timeZone: tz }, '1day')
        let baseFolder = r.aggregate.baseKey
        let tagJ0 = ot.tz(t0, tz).format('YYYYMMDDHHmmss')
        let tagJ1 = ot.tz(t0 + 16 * D, tz).format('YYYYMMDDHHmmss')
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.counted]), [[tagJ0, 'network', false]])
        assert.deepStrictEqual(r.gaps.map((v) => [v.tag, v.from, v.n, v.state]), [[tagJ1, fmtL(dropDay + 8 * H), 1, 'pending']])
        let miss = r.aggregate.missing.filter((v) => v.reason !== 'open')
        let lead = miss.filter((v) => v.time < fmtL(t0 + 16 * D))
        assert.strictEqual(lead.length, 16)
        assert.deepStrictEqual(lead[0], { time: fmtL(t0), have: 0, need: 3, reason: 'gap', cause: 'unobserved', causes: { pending: 0, nodata: 0, unobserved: 3, unknown: 0 } })
        assert.deepStrictEqual(miss.filter((v) => v.time >= fmtL(t0 + 16 * D)), [{ time: fmtL(dropDay), have: 2, need: 3, reason: 'gap', cause: 'pending', causes: { pending: 1, nodata: 0, unobserved: 0, unknown: 0 }, validCount: 1, firstValid: iso(T0) }])
        assert.ok(fs.existsSync(path.resolve(fdRoot, 'S13', 'price', baseFolder, '_gaps.json')))
        assert.ok(!fs.existsSync(path.resolve(fdRoot, 'S13', 'price', r.aggregate.key, '_gaps.json')), '合併序列之資料夾不放紀錄檔')
        //基底第一段恢復、缺根標註後: 不列 unobserved, 缺之日為 nodata
        mode.fail.clear()
        r = await run('S13', { dayStart: ds, timeZone: tz, noDataTimes: 1, timeNoData: 0 }, '1day')
        miss = r.aggregate.missing.filter((v) => v.reason !== 'open')
        assert.deepStrictEqual(miss, [{ time: fmtL(dropDay), have: 2, need: 3, reason: 'gap', cause: 'nodata', causes: { pending: 0, nodata: 1, unobserved: 0, unknown: 0 } }])
        assert.strictEqual(r.failed, undefined)
    })

    it('S14 建立 syncData 時檢測新選項(noDataTimes、timeNoData 無效即拋, 其餘無效改用預設); 各輪透傳重試與標註之選項(轉為數值; useResetGaps 不透傳)', async function() {
        //W13、W15: syncData 透傳 retryTimes、timeRetry、timeRetryMax、timeRequest、netFailTimes、noDataTimes、timeNoData; 輸入檢測規格 K3、K7、§11 決定資料口徑之 opt
        for (let [k, v, kind] of [['noDataTimes', 0, 'a positive integer'], ['noDataTimes', 'x', 'a positive integer'], ['noDataTimes', Infinity, 'a positive integer'], ['timeNoData', -1, 'a non-negative integer'], ['timeNoData', '0x10', 'a non-negative integer'], ['timeNoData', 1.5, 'a non-negative integer']]) {
            assert.throws(() => syncData('S14', 'price', ep(), 'TESTUSDT', { [k]: v }), (err) => err.message === `invalid opt.${k}: must be ${kind}`, k)
        }
        //執行參數無效改用預設(不拋); useResetGaps 無效亦不拋
        for (let [k, v] of [['retryTimes', -1], ['timeRequest', 0], ['netFailTimes', 1.5], ['timeRetry', 'x'], ['timeRetryMax', Infinity], ['useResetGaps', 'x']]) {
            let p0 = null
            assert.doesNotThrow(() => {
                p0 = syncData('S14', 'price', ep(), 'TESTUSDT', { [k]: v })
            }, k)
            assert.strictEqual(typeof p0.run, 'function')
            p0.stop()
        }
        //先有暫無數據之紀錄(T0, 1次); 其後之一輪若重置則紀錄會自第1次重新累計
        mode.drop.add(GAP)
        await run('S14')
        setNow(T0 + D)
        mode.fail.set(segStart(0), { status: 500 })
        let logs = []
        let log = console.log
        let done = null
        let pDone = new Promise((resolve) => {
            done = resolve
        })
        console.log = (...args) => {
            logs.push(args.join(' '))
            if (args[0] === 'syncData finish') {
                done()
            }
        }
        let p = null
        try {
            reqs = []
            waits = []
            //選項以數字字串給(K7): 轉為數值後透傳
            p = syncData('S14', 'price', ep(), 'TESTUSDT', { dayStart, timeZone: 'UTC', fdData: fdRoot, interval: '4hr', timeSyncInterval: 1000000, useShowLog: true, retryTimes: '1', timeRetry: '50', noDataTimes: '2', timeNoData: String(D), useResetGaps: true })
            p.run()
            await pDone
        }
        finally {
            if (p) {
                p.stop()
            }
            console.log = log
        }
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0), segStart(0)])
        assert.deepStrictEqual(waits, [50])
        //可達(最新段200)⇒ 500為有效觀察(第2次, 相隔1天) ⇒ 依 noDataTimes 2 與 timeNoData 1天 標註; 未重置(首次時刻仍為T0)
        assert.deepStrictEqual(readGaps(fdRoot, 'S14', 'price', '4hr').map((v) => [v.from, v.n, v.state, v.validCount, v.firstValid, v.lastKind, v.lastHttpStatus]), [[fmt(GAP), 1, 'nodata', 2, iso(T0), 'httpError', 500]])
    })

    it('S15 合併: 基底第一段回5xx而他段2xx(5xx為有效觀察而已有紀錄)時, 該段之目標根亦列入 missing(cause pending); 真正上市前之根仍不列', async function() {
        //W16: 修正 —— 缺之基底根所在之分段本次請求失敗者, 即使早於最早一根資料亦列入
        let tz = 'Asia/Taipei'
        let ds = '2026-01-01'
        let t0 = ot.tz(`${ds}T00:00:00`, tz).valueOf()
        let fmtL = (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')
        mode.fail.set(t0, { status: 503, body: { code: -1001 } })
        let r = await run('S15', { dayStart: ds, timeZone: tz }, '1day')
        let tagJ0 = ot.tz(t0, tz).format('YYYYMMDDHHmmss')
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.httpStatus, v.attempts, v.counted]), [[tagJ0, 'httpError', 503, 4, true]])
        assert.deepStrictEqual(r.gaps.map((v) => [v.tag, v.from, v.n, v.state, v.validCount]), [[tagJ0, fmtL(t0), 48, 'pending', 1]])
        let lead = r.aggregate.missing.filter((v) => v.reason !== 'open' && v.time < fmtL(t0 + 16 * D))
        assert.strictEqual(lead.length, 16)
        assert.deepStrictEqual(lead[15], { time: fmtL(t0 + 15 * D), have: 0, need: 3, reason: 'gap', cause: 'pending', causes: { pending: 3, nodata: 0, unobserved: 0, unknown: 0 }, validCount: 1, firstValid: iso(T0) })
        //對照: 基底第一段為真正上市前(空陣列, 未失敗) ⇒ 其目標根不列
        mode.fail.clear()
        mode.listing = t0 + 16 * D
        try {
            r = await run('S15b', { dayStart: ds, timeZone: tz }, '1day')
            assert.strictEqual(r.failed, undefined)
            assert.deepStrictEqual(r.gaps.map((v) => [v.tag, v.n, v.state]), [[tagJ0, 48, 'pending']])
            assert.deepStrictEqual(r.aggregate.missing.filter((v) => v.reason !== 'open'), [])
        }
        finally {
            mode.listing = 0
        }
    })

    it('S16 紀錄檔損毀而JSON合法(firstValid為null、非時刻、n過大、from不在格線上、tag不符、檔頭之時區或週期鍵不符): 整檔視為無紀錄、自第1次重新累計、不提早標註、不拋錯、不耗時; 以正確內容覆蓋', async function() {
        //W15: 讀紀錄檔時逐範圍檢查欄位, 不合格者整檔視為無紀錄, 下次寫入時以正確內容覆蓋
        mode.drop.add(GAP)
        let cases = [
            ['S16a', (j) => {
                j.ranges[0].firstValid = null
                j.ranges[0].validCount = 2
            }],
            ['S16b', (j) => {
                j.ranges[0].firstValid = 'garbage'
            }],
            ['S16c', (j) => {
                j.ranges[0].n = 3000000
            }],
            ['S16d', (j) => {
                j.ranges[0].from = fmt(GAP + 3600e3)
                j.ranges[0].to = fmt(GAP + 3600e3)
            }],
            ['S16g', (j) => {
                j.ranges[0].tag = tagOf(1) //GAP 不屬於段1
            }],
            ['S16h', (j) => {
                j.timeZone = 'Asia/Taipei' //與呼叫端之時區不符
            }],
            ['S16i', (j) => {
                j.interval = '1hr' //與呼叫端之週期鍵不符
            }],
        ]
        for (let [name, corrupt] of cases) {
            setNow(T0)
            await run(name)
            let j = readJson(gpOf(name))
            corrupt(j)
            fs.writeFileSync(gpOf(name), JSON.stringify(j), 'utf8')
            setNow(T0 + 2 * 60000)
            let logs = []
            let log = console.log
            console.log = (...args) => {
                logs.push(args.join(' '))
            }
            let t = performance.now()
            let r = null
            try {
                r = await run(name)
            }
            finally {
                console.log = log
            }
            assert.ok(performance.now() - t < 5000, name)
            assert.deepStrictEqual(r.gaps, [rangeOf({ firstValid: iso(T0 + 2 * 60000), lastValid: iso(T0 + 2 * 60000) })], name)
            //以正確內容(本時區與週期鍵)覆蓋
            assert.deepStrictEqual(readJson(gpOf(name)), { v: 1, interval: '4hr', timeZone: 'UTC', ranges: [rangeOf({ firstValid: iso(T0 + 2 * 60000), lastValid: iso(T0 + 2 * 60000) })] }, name)
            assert.deepStrictEqual(listTree(fdOf(name)), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`, '_gaps.json'], name)
            assert.ok(logs.every((v) => v.indexOf('can not save file') < 0), name)
        }
        //不合格之紀錄檔而該資料夾已無缺根(其後取得): 刪除之
        setNow(T0)
        await run('S16f')
        let jf = readJson(gpOf('S16f'))
        jf.ranges[0].firstValid = 'garbage'
        fs.writeFileSync(gpOf('S16f'), JSON.stringify(jf), 'utf8')
        mode.drop.delete(GAP)
        setNow(T0 + 2 * 60000)
        let rf = await run('S16f')
        assert.strictEqual(rf.gaps, undefined)
        assert.deepStrictEqual(listTree(fdOf('S16f')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`])
        //整檔非 JSON、空檔: 同樣視為無紀錄(不拋), 自第1次重新累計並以正確內容覆蓋
        mode.drop.add(GAP)
        for (let [name, content] of [['S16j', '{"v":1,"ranges":['], ['S16k', '']]) {
            setNow(T0)
            await run(name)
            fs.writeFileSync(gpOf(name), content, 'utf8')
            setNow(T0 + 2 * 60000)
            let rj = await run(name)
            assert.deepStrictEqual(rj.gaps, [rangeOf({ firstValid: iso(T0 + 2 * 60000), lastValid: iso(T0 + 2 * 60000) })], name)
            assert.strictEqual(readJson(gpOf(name)).v, 1, name)
        }
        //合併之路徑: 基底之紀錄檔損毀(firstValid 非時刻)時不 reject, 成因依重新累計之紀錄
        let tz = 'Asia/Taipei'
        let ds = '2026-01-01'
        let t0 = ot.tz(`${ds}T00:00:00`, tz).valueOf()
        let dropBar = t0 + 20 * D + 8 * H
        mode.drop.clear()
        mode.drop.add(dropBar)
        setNow(T0)
        let r = await run('S16e', { dayStart: ds, timeZone: tz }, '1day')
        let fpB = path.resolve(fdRoot, 'S16e', 'price', r.aggregate.baseKey, '_gaps.json')
        let j = readJson(fpB)
        j.ranges[0].firstValid = 'garbage'
        fs.writeFileSync(fpB, JSON.stringify(j), 'utf8')
        setNow(T0 + 2 * 60000)
        r = await run('S16e', { dayStart: ds, timeZone: tz }, '1day')
        let miss = r.aggregate.missing.filter((v) => v.reason === 'gap')
        assert.deepStrictEqual(miss.map((v) => [v.cause, v.validCount, v.firstValid]), [['pending', 1, iso(T0 + 2 * 60000)]])
    })

    it('S17 連續 netFailTimes(預設3)段皆為連線層失敗(連線錯誤、逾時)時停止本次執行之後續請求; 其間有正常回應則重新計數; 0 為不停止; syncData 透傳', async function() {
        //W13: 斷線時免得每段各等重試與逾時; 未送之段列入 failed(attempts 0, 不算觀察)
        let ds = '2026-01-01'
        let s = (k) => Date.parse('2026-01-01T00:00:00Z') + k * 8 * D
        let tagK = (k) => ot.tz(s(k), 'UTC').format('YYYYMMDDHHmmss')
        mode.failAll = { destroy: true }
        let r = await run('S17a', { dayStart: ds })
        assert.strictEqual(reqs.length, 12)
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.attempts, v.counted]), [[tagK(4), 'network', 4, false], [tagK(3), 'network', 4, false], [tagK(2), 'network', 4, false], [tagK(1), 'network', 0, false], [tagK(0), 'network', 0, false]])
        r = await run('S17b', { dayStart: ds, netFailTimes: 0 })
        assert.strictEqual(reqs.length, 20)
        assert.ok(r.failed.every((v) => v.attempts === 4))
        //其間有正常回應則重新計數(netFailTimes 2): 4 失敗、3 成功、2 失敗、1 失敗 ⇒ 停止, 0 不請求
        mode.failAll = null
        for (let k of [4, 2, 1]) {
            mode.fail.set(s(k), { destroy: true })
        }
        r = await run('S17c', { dayStart: ds, netFailTimes: 2 })
        assert.deepStrictEqual(reqs, [s(4), s(4), s(4), s(4), s(3), s(2), s(2), s(2), s(2), s(1), s(1), s(1), s(1)])
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.attempts]), [[tagK(4), 'network', 4], [tagK(2), 'network', 4], [tagK(1), 'network', 4], [tagK(0), 'network', 0]])
        //逾時亦為連線層失敗
        mode.fail.clear()
        mode.fail.set(s(4), { hang: true })
        mode.fail.set(s(3), { destroy: true })
        r = await run('S17d', { dayStart: ds, netFailTimes: 2, retryTimes: 0, timeRequest: 200 })
        assert.deepStrictEqual(reqs, [s(4), s(3)])
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.attempts]), [[tagK(4), 'timeout', 1], [tagK(3), 'network', 1], [tagK(2), 'network', 0], [tagK(1), 'network', 0], [tagK(0), 'network', 0]])
        //syncData 透傳 netFailTimes
        mode.fail.clear()
        mode.failAll = { destroy: true }
        let log = console.log
        let done = null
        let pDone = new Promise((resolve) => {
            done = resolve
        })
        console.log = (...args) => {
            if (args[0] === 'syncData finish') {
                done()
            }
        }
        let p = null
        try {
            reqs = []
            p = syncData('S17e', 'price', ep(), 'TESTUSDT', { dayStart: ds, timeZone: 'UTC', fdData: fdRoot, interval: '4hr', timeSyncInterval: 1000000, useShowLog: true, retryTimes: 0, netFailTimes: 1 })
            p.run()
            await pDone
        }
        finally {
            if (p) {
                p.stop()
            }
            console.log = log
        }
        assert.deepStrictEqual(reqs, [s(4)])
    })

    it('S18 403(防火牆封鎖)重試用盡後停止本次執行之後續請求(其餘段 attempts 0, 不算觀察)', async function() {
        //W13: 403 比照 418、429
        mode.fail.set(segStart(1), { status: 403, body: '<html>waf</html>' })
        let r = await run('S18')
        assert.deepStrictEqual(reqs, [segStart(1), segStart(1), segStart(1), segStart(1)])
        assert.deepStrictEqual(r.failed.map((v) => [v.tag, v.kind, v.httpStatus, v.attempts, v.counted]), [[tagOf(1), 'blocked', 403, 4, false], [tagOf(0), 'blocked', null, 0, false]])
        assert.deepStrictEqual(listTree(fdOf('S18')), [])
    })

    it('S19 邊界: 收棒加寬限恰等於嘗試時刻之根計入應有(差1毫秒不計); gaps 只含期間內之分段(readGaps 不限)', async function() {
        //W14: 應有之根 = 名目收棒 + timeGrace ≤ 嘗試之時刻; W16: gaps 為期間內(dayStart 至現在之各段)之紀錄
        let bar = segStart(1) + iv //02-02 04:00 之根, 收棒 08:00
        mode.drop.add(bar)
        setNow(bar + iv + 60000)
        let r = await run('S19a')
        assert.deepStrictEqual(r.gaps.map((v) => [v.tag, v.from, v.n]), [[tagOf(1), fmt(bar), 1]])
        setNow(bar + iv + 60000 - 1)
        r = await run('S19b')
        assert.strictEqual(r.gaps, undefined)
        assert.deepStrictEqual(listTree(fdOf('S19b')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`])
        //期間外(dayStart 之前之段)之紀錄: gaps 不列, readGaps 列
        mode.drop.clear()
        setNow(T0)
        await run('S19c')
        let oOut = Date.parse('2026-01-17T04:00:00Z')
        putOut('S19c', oOut)
        r = await run('S19c')
        assert.strictEqual(r.gaps, undefined)
        assert.deepStrictEqual(readGaps(fdRoot, 'S19c', 'price', '4hr').map((v) => [v.tag, v.from]), [['20260117000000', fmt(oOut)]])
        //期間內有變動而重寫紀錄檔時, 期間外之紀錄不丟失
        mode.drop.add(GAP)
        fs.rmSync(fpOf('S19c', 0))
        r = await run('S19c')
        assert.deepStrictEqual(r.gaps.map((v) => [v.tag, v.from]), [[tagOf(0), fmt(GAP)]])
        assert.deepStrictEqual(readGaps(fdRoot, 'S19c', 'price', '4hr').map((v) => [v.tag, v.from]), [['20260117000000', fmt(oOut)], [tagOf(0), fmt(GAP)]])
    })

    it('S20 每資料夾一個紀錄檔: 多段缺根時只有一個 _gaps.json(範圍帶各自之 tag、依 tag 排序、同段內合併、跨段不合併); 每次執行讀一次、有變動才寫一次(暫存檔再改名)、無變動不寫', async function() {
        //W15: 紀錄檔每資料夾一個, 與分段CSV同夾; 每次執行讀一次、有變動才以原子寫入覆寫; 無任何暫無數據與已標註時不存在
        let lastOf0 = segStart(1) - iv //段0之末根
        for (let o of [GAP, GAP + iv, lastOf0, segStart(1)]) {
            mode.drop.add(o)
        }
        //第1次執行: 檔不存在 ⇒ 不讀; 變動 ⇒ 寫 1 次(暫存檔再改名), 不直接寫紀錄檔
        let st = await spyGap(gpOf('S20'), () => run('S20'))
        assert.deepStrictEqual([st.reads, st.writes, st.renames, st.direct], [0, 1, 1, 0])
        let j = readJson(gpOf('S20'))
        assert.deepStrictEqual(j.ranges.map((v) => [v.tag, v.from, v.to, v.n]), [
            [tagOf(0), fmt(GAP), fmt(GAP + iv), 2],
            [tagOf(0), fmt(lastOf0), fmt(lastOf0), 1],
            [tagOf(1), fmt(segStart(1)), fmt(segStart(1)), 1],
        ])
        assert.deepStrictEqual(st.result.gaps.map((v) => [v.tag, v.from, v.n]), j.ranges.map((v) => [v.tag, v.from, v.n]))
        assert.deepStrictEqual(listTree(fdOf('S20')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`, '_gaps.json'])
        //每範圍一列(5 列檔頭 + 3 範圍 + 2 列結尾)
        assert.strictEqual(fs.readFileSync(gpOf('S20'), 'utf8').split('\n').length, 5 + 3 + 2)
        //第2次執行: 讀 1 次、寫 1 次(有累計)
        setNow(T0 + 3 * D)
        st = await spyGap(gpOf('S20'), () => run('S20'))
        assert.deepStrictEqual([st.reads, st.writes, st.renames, st.direct], [1, 1, 1, 0])
        assert.deepStrictEqual(readJson(gpOf('S20')).ranges.map((v) => v.validCount), [2, 2, 2])
        //標註(noDataTimes 1): 讀 1 次、寫 1 次
        setNow(T0 + 4 * D)
        st = await spyGap(gpOf('S20'), () => run('S20', { noDataTimes: 1, timeNoData: 0 }))
        assert.deepStrictEqual([st.reads, st.writes, st.renames, st.direct], [1, 1, 1, 0])
        assert.deepStrictEqual(readJson(gpOf('S20')).ranges.map((v) => v.state), ['nodata', 'nodata', 'nodata'])
        //標註後: 舊段不再請求、最新段(其缺根已標註)每次必抓但無變動 ⇒ 讀 1 次、不寫、檔案修改時間不變
        let mt = fs.statSync(gpOf('S20')).mtimeMs
        let text = fs.readFileSync(gpOf('S20'), 'utf8')
        setNow(T0 + 5 * D)
        st = await spyGap(gpOf('S20'), () => run('S20'))
        assert.deepStrictEqual([st.reads, st.writes, st.renames, st.direct], [1, 0, 0, 0])
        assert.deepStrictEqual(reqs, [segStart(1)])
        assert.strictEqual(fs.statSync(gpOf('S20')).mtimeMs, mt)
        assert.strictEqual(fs.readFileSync(gpOf('S20'), 'utf8'), text)
        assert.deepStrictEqual(listTree(fdOf('S20')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`, '_gaps.json'])
        //乾跑: 讀 1 次、不寫
        setNow(T0 + 6 * D)
        st = await spyGap(gpOf('S20'), () => run('S20', { useDryRun: true }))
        assert.deepStrictEqual([st.reads, st.writes, st.renames, st.direct], [1, 0, 0, 0])
        //全部取得(清零): 讀 1 次、刪檔(不留空檔)
        mode.drop.clear()
        for (let k of [0, 1]) {
            fs.rmSync(fpOf('S20', k), { force: true })
        }
        setNow(T0 + 7 * D)
        st = await spyGap(gpOf('S20'), () => run('S20'))
        assert.deepStrictEqual([st.reads, st.writes, st.renames, st.direct], [1, 0, 0, 0])
        assert.strictEqual(fs.existsSync(gpOf('S20')), false)
        assert.strictEqual(st.result.gaps, undefined)
        assert.deepStrictEqual(listTree(fdOf('S20')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`])
    })

    it('S21 合併: 基底資料夾之紀錄檔每次執行只讀一次(saveData 與 aggregateData 共用已讀入者); 紀錄檔只在基底資料夾, 合併序列之資料夾不放', async function() {
        //W15: 每次執行讀一次; W16: 合併之成因判定依基底之紀錄
        let tz = 'Asia/Taipei'
        let ds = '2026-01-01'
        let t0 = ot.tz(`${ds}T00:00:00`, tz).valueOf()
        mode.drop.add(t0 + 20 * D + 8 * H)
        let r = await run('S21', { dayStart: ds, timeZone: tz }, '1day')
        let fpB = path.resolve(fdRoot, 'S21', 'price', r.aggregate.baseKey, '_gaps.json')
        assert.ok(fs.existsSync(fpB))
        assert.strictEqual(fs.existsSync(path.resolve(r.aggregate.fd, '_gaps.json')), false)
        assert.deepStrictEqual(fs.readdirSync(r.aggregate.fd).filter((v) => !/\.csv$/.test(v)), [])
        for (let t of [T0 + D, T0 + 2 * D]) {
            setNow(t)
            let st = await spyGap(fpB, () => run('S21', { dayStart: ds, timeZone: tz }, '1day'))
            assert.strictEqual(st.reads, 1)
            assert.ok(st.result.aggregate.missing.some((v) => v.cause === 'pending'))
        }
    })

    it('S22 手動重置只刪期間內各段之範圍(期間外之分段之紀錄不動); useResetGaps 只有 true 為啟用(其餘視為未給); 乾跑不重置', async function() {
        //W15 手動重置; 輸入檢測規格 K3(useResetGaps 無效視為未給)
        mode.drop.add(GAP)
        await run('S22')
        let oOut = Date.parse('2026-01-17T04:00:00Z')
        putOut('S22', oOut)
        let outRange = readGaps(fdRoot, 'S22', 'price', '4hr')[0]
        assert.strictEqual(outRange.tag, '20260117000000')
        //無效值('true'、1、'y'、{})不啟用, 不拋: 紀錄照常累計
        let n = 1
        for (let v of ['true', 1, 'y', {}, null]) {
            setNow(T0 + n * D)
            let r = await run('S22', { useResetGaps: v })
            n++
            assert.deepStrictEqual(r.gaps.map((x) => [x.tag, x.validCount]), [[tagOf(0), n]], String(v))
        }
        //乾跑(給 true)不重置
        let text = fs.readFileSync(gpOf('S22'), 'utf8')
        setNow(T0 + n * D)
        await run('S22', { useResetGaps: true, useDryRun: true })
        assert.strictEqual(fs.readFileSync(gpOf('S22'), 'utf8'), text)
        //true: 期間內之範圍自第1次重新累計, 期間外者原樣保留
        setNow(T0 + n * D)
        let st = await spyGap(gpOf('S22'), () => run('S22', { useResetGaps: true }))
        assert.deepStrictEqual(st.result.gaps.map((x) => [x.tag, x.validCount, x.firstValid]), [[tagOf(0), 1, iso(T0 + n * D)]])
        let all = readGaps(fdRoot, 'S22', 'price', '4hr')
        assert.deepStrictEqual(all.map((x) => x.tag), ['20260117000000', tagOf(0)])
        assert.deepStrictEqual(all[0], outRange)
        //讀 1 次; 重置先寫入(1 次), 其後重新累計之紀錄於最後再寫 1 次
        assert.deepStrictEqual([st.reads, st.writes, st.renames, st.direct], [1, 2, 2, 0])
        //期間內無紀錄而給 true: 不寫(檔案不變)
        mode.drop.clear()
        fs.rmSync(fpOf('S22', 0))
        setNow(T0 + (n + 1) * D)
        await run('S22', { useResetGaps: true })
        assert.deepStrictEqual(readGaps(fdRoot, 'S22', 'price', '4hr').map((x) => x.tag), ['20260117000000'])
    })

    it('S23 選項檢測: noDataTimes、timeNoData 給了而無效即 reject(先於任何連網、建夾、寫檔); 數字字串轉為數值; 執行參數無效改用預設(不拋)', async function() {
        //輸入檢測規格 K3、K7、V17、V19、V20、§11 決定資料口徑之 opt
        let secret = 'SECRET-VALUE-4471'
        let bad = [
            ['noDataTimes', 0, 'a positive integer'], ['noDataTimes', -3, 'a positive integer'], ['noDataTimes', 1.5, 'a positive integer'], ['noDataTimes', 'x', 'a positive integer'], ['noDataTimes', '', 'a positive integer'],
            ['noDataTimes', Infinity, 'a positive integer'], ['noDataTimes', '0x10', 'a positive integer'], ['noDataTimes', NaN, 'a positive integer'], ['noDataTimes', true, 'a positive integer'], ['noDataTimes', secret, 'a positive integer'],
            ['timeNoData', -1, 'a non-negative integer'], ['timeNoData', 0.5, 'a non-negative integer'], ['timeNoData', 'abc', 'a non-negative integer'], ['timeNoData', Infinity, 'a non-negative integer'], ['timeNoData', '0x10', 'a non-negative integer'], ['timeNoData', {}, 'a non-negative integer'],
        ]
        for (let [k, v, kind] of bad) {
            for (let extra of [{}, { useDryRun: true }]) {
                reqs = []
                let name = `S23_${k}`
                await assert.rejects(run(name, { [k]: v, ...extra }), (err) => err.message === `invalid opt.${k}: must be ${kind}` && err.message.indexOf(secret) < 0, `${k}=${String(v)}`)
                assert.deepStrictEqual(reqs, [], `${k}=${String(v)}`)
                assert.strictEqual(fs.existsSync(path.resolve(fdRoot, name)), false, `${k}=${String(v)}`)
            }
        }
        //合併之路徑亦先於任何連網與建夾
        reqs = []
        await assert.rejects(run('S23_agg', { noDataTimes: 0, timeZone: 'Asia/Taipei', dayStart: '2026-01-01' }, '1day'), (err) => err.message === 'invalid opt.noDataTimes: must be a positive integer')
        assert.deepStrictEqual(reqs, [])
        assert.strictEqual(fs.existsSync(path.resolve(fdRoot, 'S23_agg')), false)
        //數字字串: 轉為數值後使用(K4)
        mode.drop.add(GAP)
        let r = await run('S23_str', { noDataTimes: '1', timeNoData: ' 0 ' })
        assert.deepStrictEqual(r.gaps.map((v) => [v.state, v.validCount]), [['nodata', 1]])
        //執行參數無效(負數、小數、Infinity、'x'、'0x10')改用預設: 失敗之段重試 3 次(共 4 次請求), 等待 1、3、9 秒; 不拋
        mode.drop.clear()
        for (let [k, v] of [['retryTimes', -1], ['retryTimes', 1.5], ['retryTimes', Infinity], ['retryTimes', '0x10'], ['timeRetry', 'x'], ['timeRetry', -1], ['timeRetryMax', NaN], ['timeRequest', 0], ['netFailTimes', 1.5]]) {
            mode.fail.set(segStart(0), { status: 500 })
            let rr = await run(`S23_${k}`, { [k]: v })
            assert.deepStrictEqual(reqs, [segStart(1), segStart(0), segStart(0), segStart(0), segStart(0)], `${k}=${String(v)}`)
            assert.deepStrictEqual(waits, [1000, 3000, 9000], `${k}=${String(v)}`)
            assert.deepStrictEqual(rr.failed.map((x) => [x.kind, x.attempts]), [['httpError', 4]], `${k}=${String(v)}`)
        }
        //數字字串: retryTimes '1'、timeRetry '10' ⇒ 1 次重試, 等待 10 毫秒
        mode.fail.set(segStart(0), { status: 500 })
        let rs = await run('S23_s', { retryTimes: '1', timeRetry: '10' })
        assert.deepStrictEqual(reqs, [segStart(1), segStart(0), segStart(0)])
        assert.deepStrictEqual(waits, [10])
        assert.deepStrictEqual(rs.failed.map((x) => x.attempts), [2])
    })

    it('S24 紀錄檔寫入失敗不中斷(印 can not save file 後照常回傳, 不留暫存檔); 回傳之 gaps 為本次之紀錄', async function() {
        //W15: 單一檔案寫入失敗不中斷(同分段檔); 原子寫入失敗清除暫存檔
        mode.drop.add(GAP)
        fs.mkdirSync(gpOf('S24'), { recursive: true }) //紀錄檔之路徑為資料夾 ⇒ 改名失敗
        let logs = []
        let log = console.log
        console.log = (...args) => {
            logs.push(args.map((v) => (v instanceof Error ? v.message : String(v))).join(' '))
        }
        let r = null
        try {
            r = await run('S24')
        }
        finally {
            console.log = log
        }
        assert.ok(logs.some((v) => v.indexOf('can not save file') === 0 && v.indexOf('_gaps.json') > 0))
        assert.deepStrictEqual(r.gaps.map((v) => [v.tag, v.from, v.state]), [[tagOf(0), fmt(GAP), 'pending']])
        assert.deepStrictEqual(listTree(fdOf('S24')), [`${tagOf(0)}.csv`, `${tagOf(1)}.csv`, '_gaps.json'])
        assert.strictEqual(fs.statSync(gpOf('S24')).isDirectory(), true)
    })

})
