import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import saveData from '../src/saveData.mjs'
import { install, setNow, uninstall } from './tools/fakeClock.mjs'


ot.extend(utc)
ot.extend(timezone)


//規格出處: saveData 之 JSDoc 與 README〈Intervals and day boundary〉(週期表、不支援之週期、直接下載時之日界與分段起點不在格點上之行為)
//本檔皆以 opt.aggregateFrom 為 'none'(直接下載原生週期); 依時區合併見 api-saveDataAggregate.test.mjs
//各 it 之註解標明對應之規格句

let fdRoot = './test/_tmp/api-saveDataIntervals'
let H = 3600 * 1000
let D = 24 * H

//SPEC, README 週期表: 送交易所之週期、每根秒數、每段時數、每段筆數
let SPEC = {
    '1m': { ex: '1m', sec: 60, segH: 1, num: 60 },
    '3m': { ex: '3m', sec: 180, segH: 3, num: 60 },
    '5m': { ex: '5m', sec: 300, segH: 4, num: 48 },
    '15m': { ex: '15m', sec: 900, segH: 12, num: 48 },
    '30m': { ex: '30m', sec: 1800, segH: 24, num: 48 },
    '1hr': { ex: '1h', sec: 3600, segH: 48, num: 48 },
    '2hr': { ex: '2h', sec: 7200, segH: 96, num: 48 },
    '4hr': { ex: '4h', sec: 14400, segH: 192, num: 48 },
    '6hr': { ex: '6h', sec: 21600, segH: 288, num: 48 },
    '8hr': { ex: '8h', sec: 28800, segH: 384, num: 48 },
    '12hr': { ex: '12h', sec: 43200, segH: 576, num: 48 },
    '1day': { ex: '1d', sec: 86400, segH: 1152, num: 48 },
    '1week': { ex: '1w', sec: 604800, segH: 8064, num: 48 },
}

//假交易所: 各原生週期之秒數與開盤對齊偏移(1w 開於週一 UTC 00:00, epoch 0 為週四, 偏移 4 天), 對齊方式同幣安之實測
let EX_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200, '1d': 86400, '1w': 604800 }
let EX_OFF = { '1w': 4 * D }

//vals, 各根之值逐根逐欄相異(k 為該根於其週期之序號)
let vals = (o, d) => {
    let k = Math.round(o / d) % 1000000
    return {
        o: `${k}.1`,
        h: `${k}.9`,
        l: `${k}.0`,
        c: `${k}.5`,
        v: `${k}.01`,
        q: `${k}.02`,
        n: k + 3,
        tb: `${k}.03`,
        tq: `${k}.04`,
    }
}

//firstOpen, 不早於 t 之首根開盤
let firstOpen = (ex, t) => {
    let d = EX_SEC[ex] * 1000
    let off = EX_OFF[ex] || 0
    return Math.ceil((t - off) / d) * d + off
}

let reqs = [] //收到之請求 { startTime, endTime, interval, limit, keys }
let mode = {
    empty: {}, //startTime -> 回空陣列(該段尚無根)
}

let genBars = (ex, startTime, endTime, now) => {
    let d = EX_SEC[ex] * 1000
    let rs = []
    if (mode.empty[startTime]) {
        return rs
    }
    for (let o = firstOpen(ex, startTime); o <= endTime && o <= now; o += d) {
        let x = vals(o, d)
        rs.push([o, x.o, x.h, x.l, x.c, x.v, o + d - 1, x.q, x.n, x.tb, x.tq, '0'])
    }
    return rs
}

let fmtOf = (tz) => (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')

//rowFinal, downloadData 寫出之定稿列
let rowFinal = (ex, o, tz) => {
    let d = EX_SEC[ex] * 1000
    let fmt = fmtOf(tz)
    let x = vals(o, d)
    return [fmt(o), x.o, x.h, x.l, x.c, x.v, fmt(o + d - 1), x.q, x.n, x.tb, x.tq].join(', ')
}

//csvSeg, 段 [ts, te) 內各根之定稿內容; partialLast 為 true 時末根改為未收棒時擷取之值
let csvSeg = (ex, ts, te, tz, partialLast = false) => {
    let d = EX_SEC[ex] * 1000
    let fmt = fmtOf(tz)
    let rows = []
    for (let o = firstOpen(ex, ts); o < te; o += d) {
        rows.push(rowFinal(ex, o, tz))
    }
    if (partialLast) {
        let o = firstOpen(ex, ts) + (rows.length - 1) * d
        rows[rows.length - 1] = [fmt(o), '1.1', '1.2', '1.0', '1.15', '3', fmt(o + 3600e3), '300', 2, '1', '100'].join(', ')
    }
    return rows.join('\n')
}

//ctx, 依週期鍵、時區、dayStart 計算各段起點等
let ctxOf = (key, tz, dayStart) => {
    let sp = SPEC[key]
    let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
    let segMs = sp.segH * H
    let segStart = (k) => t0 + k * segMs
    let kLatest = Math.floor((Date.now() - t0) / segMs)
    let tagOf = (k) => ot.tz(segStart(k), tz).format('YYYYMMDDHHmmss')
    return { sp, t0, segMs, segStart, kLatest, tagOf, fmt: fmtOf(tz) }
}

//dayStartOf, 令最新段已開始 lag 天(lag < 每段天數; 至多 15 天, 使前一段之跨段界末根(至多 7 天)於現在已收棒, 且 1week 之最新段至少 2 根); 每段不足 1 天者取前一天
let dayStartOf = (key, tz) => {
    let segDays = SPEC[key].segH / 24
    let today = ot.tz(Date.now(), tz).format('YYYY-MM-DD')
    let back = 1
    if (segDays >= 1) {
        let lag = Math.min(segDays - 1, 15)
        back = 2 * segDays + lag
    }
    return ot.tz(`${today}T00:00:00`, tz).add(-back, 'day').format('YYYY-MM-DD')
}

//T0, 測試之「現在」(假時鐘, 每案開始時重設, 案內不前進): 台北 2026-11-20(週五) 10:00, 不在任何週期之段界上
let T0 = Date.parse('2026-11-20T02:00:00Z')

let port = 0
let endpoint = ''
let server = null

let run = (name, key, opt = {}) => {
    reqs = []
    return saveData(name, 'price', endpoint, 'TESTUSDT', key, {
        fdData: fdRoot,
        aggregateFrom: 'none', //本檔測直接下載原生週期(週期表、日界、分段); 依時區合併見 api-saveDataAggregate
        ...opt,
    })
}

let fdOf = (name, key) => path.resolve(fdRoot, name, 'price', key)
let fpOf = (name, key, tag) => `${fdOf(name, key)}/${tag}.csv`
let writeSeg = (fp, c, mtimeMs) => {
    fs.writeFileSync(fp, c, 'utf8')
    fs.utimesSync(fp, new Date(), new Date(mtimeMs))
}

//quiet, 執行期間收集 console.log(不支援之鍵會先印週期表)
let quiet = async (fn) => {
    let logs = []
    let log = console.log
    console.log = (...args) => {
        logs.push(args.map((v) => typeof v === 'string' ? v : JSON.stringify(v)).join(' '))
    }
    try {
        await fn()
    }
    finally {
        console.log = log
    }
    return logs
}


//t1, T1 之本體: 乾跑之分段、實抓之請求與各舊段內容、第二輪收斂
let t1 = async (key, tz) => {
    let dayStart = dayStartOf(key, tz)
    let c = ctxOf(key, tz, dayStart)
    let name = `T1_${key}_${tz.replace('/', '_')}`

    //乾跑: 各段之 ts、te 為段起點與下一段起點前 1 秒(每段時長)
    let rd = await run(name, key, { dayStart, timeZone: tz, useDryRun: true })
    assert.strictEqual(reqs.length, 0)
    let kSeq = []
    for (let k = c.kLatest; k >= 0; k--) {
        kSeq.push(k)
    }
    assert.deepStrictEqual(rd.items.map((v) => [v.tag, v.ts, v.te, v.reason]), kSeq.map((k) => [
        c.tagOf(k),
        c.fmt(c.segStart(k)),
        c.fmt(c.segStart(k + 1) - 1000),
        k === c.kLatest ? 'latest' : 'notExist',
    ]))

    //實抓: 請求之週期為送交易所之週期, 區間為各段, 不帶 timeZone
    await run(name, key, { dayStart, timeZone: tz, timeGrace: 0 })
    assert.deepStrictEqual(reqs.map((v) => [v.startTime, v.endTime, v.interval, v.limit, v.keys]), kSeq.map((k) => [
        c.segStart(k),
        c.segStart(k + 1) - 1000,
        c.sp.ex,
        '1000',
        'endTime,interval,limit,startTime,symbol',
    ]))

    //各舊段恰為每段筆數, 內容為該段內各根
    for (let k = 0; k < c.kLatest; k++) {
        let s = fs.readFileSync(fpOf(name, key, c.tagOf(k)), 'utf8')
        assert.strictEqual(s.split('\n').length, c.sp.num, `k=${k}`)
        assert.strictEqual(s, csvSeg(c.sp.ex, c.segStart(k), c.segStart(k + 1), tz), `k=${k}`)
    }

    //第二輪: 舊段皆完整(筆數符合且已收棒), 只抓最新段
    await run(name, key, { dayStart, timeZone: tz, timeGrace: 0 })
    assert.deepStrictEqual(reqs.map((v) => v.startTime), [c.segStart(c.kLatest)])
}


describe('api-saveDataIntervals', function() {

    before(async function() {
        install(T0)
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
        server = http.createServer((req, res) => {
            let u = new URL(req.url, 'http://127.0.0.1')
            let q = {
                startTime: Number(u.searchParams.get('startTime')),
                endTime: Number(u.searchParams.get('endTime')),
                interval: u.searchParams.get('interval'),
                limit: u.searchParams.get('limit'),
                keys: [...u.searchParams.keys()].sort().join(','),
                at: Date.now(), //回應之時刻, 回傳之根為開盤不晚於此者
            }
            reqs.push(q)
            if (EX_SEC[q.interval] === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ code: -1120, msg: 'Invalid interval.' }))
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(genBars(q.interval, q.startTime, q.endTime, q.at)))
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        port = server.address().port
        endpoint = `http://127.0.0.1:${port}/api/v3/klines`
    })

    beforeEach(function() {
        setNow(T0)
    })

    after(async function() {
        uninstall()
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(fdRoot, { recursive: true, force: true })
        //test/_tmp 已無其他測試之暫存時一併移除(並行之測試可能同時建立或移除, 不拋)
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

    //Asia/Taipei 之段起點為 16:00Z(6hr、12hr、1day、1week 之格點不在此); Asia/Kolkata 之段起點為 18:30Z(各小時以上週期之格點皆不在此)
    for (let tz of ['Asia/Taipei', 'Asia/Kolkata']) {

        for (let key of Object.keys(SPEC)) {

            it(`T1 ${key} ${tz}: 送交易所之週期、每段時長與筆數如週期表, 第二輪只抓最新段`, async function() {
                //規格: 週期表(送交易所、每段時長、每段筆數); 每段時長為每根時長之整數倍(分段起點不在格點上時每段仍為應有筆數); 既有且完整之分段不重抓
                await t1(key, tz)
            })

        }

    }

    it('T2 不支援之週期鍵拋錯: 訊息為 must be one of 各週期鍵且不回顯輸入值, 拋錯前不印週期表、不建夾、不發請求', async function() {
        //規格: 交易所之 3d、1M、1s 不支援; 週期鍵須為週期表所列(交易所字串如 '1h'、'1d' 不是週期鍵; 原型鏈成員名如 'constructor' 亦不是); 訊息 'invalid interval: must be one of <各週期鍵>', 不帶輸入值(V19、V20), 拋錯前不再印週期表
        let msg = `invalid interval: must be one of ${Object.keys(SPEC).join(', ')}`
        for (let key of ['3day', '1month', '1s', '3d', '1M', '1h', '1d', '1w', 'day', '1Day', 'constructor', 'toString', '__proto__', 'zzzSecretKey9', '', undefined, null, 5]) {
            let logs = await quiet(async () => {
                await assert.rejects(run('T2', key, { dayStart: '2026-01-01' }), (err) => err.message === msg, String(key))
            })
            assert.strictEqual(reqs.length, 0, String(key))
            assert.strictEqual(fs.existsSync(path.resolve(fdRoot, 'T2')), false, String(key))
            assert.deepStrictEqual(logs, [], String(key))
        }
    })

    it('T3 直接下載時日線以上之根以 UTC 對齊, 不受 timeZone 影響; timeZone 只決定標示與分段起點', async function() {
        //規格: 1day 為 UTC 00:00, 1week 為週一 UTC 00:00; 不送交易所之 timeZone 參數; aggregateFrom 為 'none' 且 timeZone 為 'Asia/Taipei' 時 1day 之各根標為 'YYYY-MM-DDT08:00:00'
        for (let [key, tz, hhmmss] of [['1day', 'UTC', '00:00:00'], ['1day', 'Asia/Taipei', '08:00:00'], ['1week', 'UTC', '00:00:00'], ['1week', 'Asia/Taipei', '08:00:00']]) {
            let dayStart = dayStartOf(key, tz)
            let c = ctxOf(key, tz, dayStart)
            let name = `T3_${tz.replace('/', '_')}`
            await run(name, key, { dayStart, timeZone: tz, timeGrace: 0 })
            assert.ok(reqs.every((v) => v.keys.split(',').indexOf('timeZone') < 0), `${key} ${tz}`)
            //檔名為段起點(該時區 00:00)
            for (let k = 0; k <= c.kLatest; k++) {
                assert.ok(c.tagOf(k).endsWith('000000'), `${key} ${tz} k=${k}`)
            }
            //各根之開盤: 標示之時分秒、星期(1week 為週一)
            for (let k = 0; k < c.kLatest; k++) {
                let rows = fs.readFileSync(fpOf(name, key, c.tagOf(k)), 'utf8').split('\n')
                assert.strictEqual(rows.length, 48)
                for (let r of rows) {
                    let t = r.split(', ')[0]
                    assert.strictEqual(t.slice(11), hhmmss, `${key} ${tz} ${t}`)
                    let ms = ot.tz(t, tz).valueOf()
                    assert.strictEqual(ms % D, 0, `${key} ${tz} ${t} 非 UTC 00:00`)
                    if (key === '1week') {
                        assert.strictEqual(new Date(ms).getUTCDay(), 1, `${key} ${tz} ${t} 非週一`)
                    }
                }
            }
        }
    })

    for (let [key, lagH] of [['6hr', 2], ['12hr', 8], ['1day', 8], ['1week', null]]) {

        it(`T4 ${key} 台北段界不在格點上: 跨段界之末根於名目收棒加寬限前擷取者重抓, 之後不重抓`, async function() {
            //規格: 分段起點不在對齊格點上時, 每段仍為應有筆數, 段末根之收棒晚於段終點, 完整與否以末根之名目收棒判定
            let tz = 'Asia/Taipei'
            let grace = 60 * 1000
            let dayStart = dayStartOf(key, tz)
            let c = ctxOf(key, tz, dayStart)
            let name = `T4_${key}`
            fs.mkdirSync(fdOf(name, key), { recursive: true })
            let k = 0
            let ts = c.segStart(k)
            let te = c.segStart(k + 1)
            let d = c.sp.sec * 1000
            let lastOpen = firstOpen(c.sp.ex, ts) + (c.sp.num - 1) * d
            let lastClose = lastOpen + d
            //前提: 末根跨段界, 名目收棒晚於段終點 lagH 小時(1week 依段終點之星期為 8 小時加 0~6 天); 首根晚於段起點開盤
            if (lagH !== null) {
                assert.strictEqual(lastClose - te, lagH * H)
            }
            else {
                assert.ok(lastClose - te >= 8 * H && (lastClose - te - 8 * H) % D === 0, `${lastClose - te}`)
            }
            assert.ok(firstOpen(c.sp.ex, ts) > ts)
            //其他舊段先抓齊, 只看段 k
            await run(name, key, { dayStart, timeZone: tz })
            let fp = fpOf(name, key, c.tagOf(k))
            let cFinal = csvSeg(c.sp.ex, ts, te, tz)
            assert.strictEqual(fs.readFileSync(fp, 'utf8'), cFinal)

            //擷取時刻晚於段終點 1 小時但早於末根名目收棒: 不完整而重抓
            writeSeg(fp, csvSeg(c.sp.ex, ts, te, tz, true), te + 1 * H - 1000)
            let r = await run(name, key, { dayStart, timeZone: tz })
            assert.deepStrictEqual(reqs.map((v) => v.startTime), [c.segStart(c.kLatest), ts])
            assert.deepStrictEqual(r.items.filter((v) => v.tag === c.tagOf(k)).map((v) => v.reason), ['beforeClose'])
            assert.strictEqual(fs.readFileSync(fp, 'utf8'), cFinal)

            //擷取時刻為末根名目收棒加寬限前 1 毫秒: 仍重抓; 恰為名目收棒加寬限: 完整不重抓
            writeSeg(fp, cFinal, lastClose + grace - 1)
            await run(name, key, { dayStart, timeZone: tz })
            assert.deepStrictEqual(reqs.map((v) => v.startTime), [c.segStart(c.kLatest), ts])
            writeSeg(fp, cFinal, lastClose + grace)
            await run(name, key, { dayStart, timeZone: tz })
            assert.deepStrictEqual(reqs.map((v) => v.startTime), [c.segStart(c.kLatest)])
        })

    }

    it('T5 1day 最新段於首根開盤前回應為空: 不寫檔、timeLast 與 timeKeep 為 undefined, 前一段之形成中之根照常重抓', async function() {
        //規格: 最新分段於其首根開盤前回應為空, 此時不寫檔且 timeLast 與 timeKeep 為 undefined, 仍在形成之根屬前一段, 由前一段之不完整判定重抓更新
        let key = '1day'
        let tz = 'Asia/Taipei'
        let dayStart = dayStartOf(key, tz)
        let c = ctxOf(key, tz, dayStart)
        let name = 'T5'
        await run(name, key, { dayStart, timeZone: tz })
        let kPrev = c.kLatest - 1
        let fpPrev = fpOf(name, key, c.tagOf(kPrev))
        let fpLatest = fpOf(name, key, c.tagOf(c.kLatest))
        fs.rmSync(fpLatest)
        //前一段之末根於形成中被擷取(擷取時刻早於其名目收棒)
        let tePrev = c.segStart(kPrev + 1)
        writeSeg(fpPrev, csvSeg('1d', c.segStart(kPrev), tePrev, tz, true), tePrev + 2 * H)
        mode.empty[c.segStart(c.kLatest)] = true
        try {
            let logs = []
            let r = null
            logs = await quiet(async () => {
                r = await run(name, key, { dayStart, timeZone: tz })
            })
            assert.deepStrictEqual(reqs.map((v) => v.startTime), [c.segStart(c.kLatest), c.segStart(kPrev)])
            assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [[c.tagOf(c.kLatest), 'latest'], [c.tagOf(kPrev), 'beforeClose']])
            assert.strictEqual(fs.existsSync(fpLatest), false)
            assert.strictEqual(r.timeLast, undefined)
            assert.strictEqual(r.timeKeep, undefined)
            assert.strictEqual(fs.readFileSync(fpPrev, 'utf8'), csvSeg('1d', c.segStart(kPrev), tePrev, tz))
            assert.ok(logs.length > 0)
        }
        finally {
            mode.empty = {}
        }
    })

    //snap, 某資料夾內各分段檔之內容與修改時間
    let snap = (name, folder) => {
        let fd = fdOf(name, folder)
        let r = {}
        for (let f of fs.readdirSync(fd).sort()) {
            r[f] = { c: fs.readFileSync(`${fd}/${f}`, 'utf8'), mtimeMs: fs.statSync(`${fd}/${f}`).mtimeMs }
        }
        return r
    }

    for (let key of ['1m', '5m', '15m', '30m', '1hr', '4hr']) {

        for (let tz of ['Asia/Taipei', 'UTC']) {

            it(`T7 ${key} ${tz}: 既有六鍵未給 aggregateFrom 時為直接下載, 與明給 none 之請求、資料夾、檔案內容與修改時間、回傳逐位相同(含乾跑、第二輪)`, async function() {
                //規格: aggregateFrom 未給時為 'auto'; 既有六鍵於台北與 UTC 之原生格線與界線對齊, 直接下載(行為與 1.0.58 相同: 資料夾為週期鍵、回傳不含 aggregate); 'none' 為原生格線
                let dayStart = dayStartOf(key, tz)
                let nameA = `T7a_${key}_${tz.replace('/', '_')}`
                let nameB = `T7b_${key}_${tz.replace('/', '_')}`
                let out = {}
                for (let [nm, af] of [[nameA, undefined], [nameB, 'none']]) {
                    let rd = await run(nm, key, { dayStart, timeZone: tz, useDryRun: true, aggregateFrom: af })
                    let reqsDry = reqs
                    let r1 = await run(nm, key, { dayStart, timeZone: tz, aggregateFrom: af })
                    let reqs1 = reqs
                    let r2 = await run(nm, key, { dayStart, timeZone: tz, aggregateFrom: af })
                    out[nm] = { rd, reqsDry, r1, reqs1, r2, reqs2: reqs, tree: snap(nm, key), folders: fs.readdirSync(path.resolve(fdRoot, nm, 'price')) }
                }
                assert.deepStrictEqual(out[nameA], out[nameB])
                assert.deepStrictEqual(out[nameA].folders, [key])
                assert.strictEqual(out[nameA].reqsDry.length, 0)
                assert.ok(out[nameA].reqs1.length > 0)
                assert.deepStrictEqual(Object.keys(out[nameA].r1).sort(), ['items', 'timeKeep', 'timeLast'])
                assert.ok(out[nameA].reqs1.every((v) => v.interval === SPEC[key].ex && v.keys === 'endTime,interval,limit,startTime,symbol'))
            })

        }

    }

    for (let key of ['12hr', '1day', '1week']) {

        it(`T6 ${key} 最新段之末根未收: 結束時間為擷取時刻, timeLast 與 timeKeep 取自最新段末兩列`, async function() {
            //規格(沿用既有): 某根K線若於擷取當下尚未收棒, 其結束時間改為擷取時刻; timeLast與timeKeep為本次下載之最新分段末兩列之開始時間
            let tz = 'UTC'
            let dayStart = dayStartOf(key, tz)
            let c = ctxOf(key, tz, dayStart)
            let name = `T6_${key}`
            let tBefore = Math.floor(Date.now() / 1000) * 1000
            let r = await run(name, key, { dayStart, timeZone: tz })
            let tAfter = Date.now()
            let d = c.sp.sec * 1000
            let rows = fs.readFileSync(fpOf(name, key, c.tagOf(c.kLatest)), 'utf8').split('\n')
            //最新段之請求為首個請求, 其回應含開盤不晚於回應時刻之各根
            assert.strictEqual(reqs[0].startTime, c.segStart(c.kLatest))
            let opens = []
            for (let o = firstOpen(c.sp.ex, c.segStart(c.kLatest)); o <= reqs[0].at; o += d) {
                opens.push(o)
            }
            //前提: 最新段至少 2 根, 末根於擷取時尚未收棒
            assert.ok(opens.length >= 2)
            assert.ok(opens[opens.length - 1] + d > tAfter)
            assert.strictEqual(rows.length, opens.length)
            for (let i = 0; i < rows.length - 1; i++) {
                assert.strictEqual(rows[i], rowFinal(c.sp.ex, opens[i], tz))
            }
            let cols = rows[rows.length - 1].split(', ')
            let tEnd = ot.tz(cols[6], tz).valueOf()
            assert.strictEqual(cols[0], c.fmt(opens[opens.length - 1]))
            assert.ok(tEnd >= tBefore && tEnd <= tAfter, `${cols[6]}`)
            assert.strictEqual(r.timeLast, c.fmt(opens[opens.length - 1]))
            assert.strictEqual(r.timeKeep, c.fmt(opens[opens.length - 2]))
        })

    }

})
