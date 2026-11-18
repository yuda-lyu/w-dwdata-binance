import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import saveData from '../src/saveData.mjs'
import syncData from '../src/syncData.mjs'
import { getIntervalPlan } from '../src/intervals.mjs'
import { install, setNow, uninstall } from './tools/fakeClock.mjs'


ot.extend(utc)
ot.extend(timezone)


//規格出處: saveData 與 intervals.mjs(getIntervalPlan)之 JSDoc、README〈Intervals and day boundary〉之「依時區合併」各句
//各 it 之註解標明對應之規格句
//假交易所: 以逐分鐘之合成序列(各欄逐分鐘相異)聚合出各原生週期之根, 故不同基底合併之結果與直接由逐分鐘聚合之結果(對照解)應逐位相同

let fdRoot = './test/_tmp/api-saveDataAggregate'
let M = 60 * 1000
let H = 60 * M
let D = 24 * H
let E8 = 10n ** 8n

let EX_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200, '1d': 86400, '1w': 604800 }
let EX_OFF = { '1w': 4 * D }

//週期表(README): 每段時數
let SEG_H = { '1m': 1, '3m': 3, '5m': 4, '15m': 12, '30m': 24, '1hr': 48, '2hr': 96, '4hr': 192, '6hr': 288, '8hr': 384, '12hr': 576, '1day': 1152, '1week': 8064 }
let SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1hr': 3600, '2hr': 7200, '4hr': 14400, '6hr': 21600, '8hr': 28800, '12hr': 43200, '1day': 86400, '1week': 604800 }

//fmt8, 放大1e8之整數 -> 8位小數字串
let fmt8 = (v) => {
    let neg = v < 0n
    let a = neg ? -v : v
    let s = a.toString().padStart(9, '0')
    return `${neg ? '-' : ''}${s.slice(0, -8)}.${s.slice(-8)}`
}

//minute, 第 m 分鐘(epoch 分鐘數)之值; price 與 index 之各欄逐分鐘相異
let minute = (type, m) => {
    let k = BigInt(m)
    if (type === 'index') {
        let o = ((k * 13n) % 2001n - 1000n) * 1000n
        let c = o + ((k * 7n) % 401n - 200n) * 100n
        let h = (o > c ? o : c) + ((k * 3n) % 97n) * 100n + 1n
        let l = (o < c ? o : c) - ((k * 5n) % 89n) * 100n - 1n
        return { o, h, l, c, v: null, q: null, n: 12n, tb: null, tq: null }
    }
    let o = 3000n * E8 + ((k * 7919n) % 200003n) * 1000n
    let c = o + ((k * 104729n) % 4001n - 2000n) * 1000n
    let h = (o > c ? o : c) + ((k * 31n) % 997n) * 1000n + 1n
    let l = (o < c ? o : c) - ((k * 17n) % 991n) * 1000n - 1n
    let v = ((k % 97n) + 1n) * E8 + (k % 1000n) * 12345n
    let q = v * 3000n + (k % 7n)
    return { o, h, l, c, v, q, n: (k % 50n) + 1n, tb: v / 2n + (k % 3n), tq: q / 2n + (k % 5n) }
}

//aggMin, 聚合 [o, e) 之逐分鐘值(只含不晚於 now 者); 無分鐘時回 null
let aggMin = (type, o, e, now = Infinity) => {
    let r = null
    for (let t = o; t < e && t <= now; t += M) {
        let x = minute(type, t / M)
        if (r === null) {
            r = { ...x }
            continue
        }
        r.h = x.h > r.h ? x.h : r.h
        r.l = x.l < r.l ? x.l : r.l
        r.c = x.c
        r.n += x.n
        if (type === 'price') {
            r.v += x.v
            r.q += x.q
            r.tb += x.tb
            r.tq += x.tq
        }
    }
    return r
}

let colsOf = (type, r) => {
    let z = (v) => (type === 'index' ? '0' : fmt8(v))
    return [fmt8(r.o), fmt8(r.h), fmt8(r.l), fmt8(r.c), z(r.v), z(r.q), r.n, z(r.tb), z(r.tq)]
}

let fmtOf = (tz) => (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')

//oracleRow, 對照解: 目標根 [o, o+t) 直接由逐分鐘聚合, 欄位格式同 downloadData 之輸出
let oracleRow = (type, o, t, tz) => {
    let fmt = fmtOf(tz)
    let c = colsOf(type, aggMin(type, o, o + t))
    return [fmt(o), c[0], c[1], c[2], c[3], c[4], fmt(o + t - 1000), c[5], c[6], c[7], c[8]].join(', ')
}

let reqs = []
let mode = {
    drop: new Set(), //`${type}|${ex}|${open}` 之根不回傳(交易所缺漏)
    status500: new Set(), //`${type}|${ex}|${startTime}` 之請求回 500
    listing: 0, //早於此之分鐘無資料(上市前)
}

let barsOf = (type, ex, s, e, now) => {
    let d = EX_SEC[ex] * 1000
    let off = EX_OFF[ex] || 0
    let rs = []
    for (let o = Math.ceil((s - off) / d) * d + off; o <= e && o <= now; o += d) {
        if (mode.drop.has(`${type}|${ex}|${o}`)) {
            continue
        }
        let r = aggMin(type, Math.max(o, mode.listing), o + d, now)
        if (r === null) {
            continue
        }
        let c = colsOf(type, r)
        rs.push([o, c[0], c[1], c[2], c[3], c[4], o + d - 1, c[5], Number(c[6]), c[7], c[8], '0'])
    }
    return rs
}

let port = 0
let server = null
let epOf = (type) => `http://127.0.0.1:${port}/${type}/klines`

let run = (name, type, key, opt = {}) => {
    reqs = []
    return saveData(name, type, epOf(type), 'TESTUSDT', key, {
        fdData: fdRoot,
        ...opt,
    })
}
let fdOf = (name, type, folder) => path.resolve(fdRoot, name, type, folder)
let readTree = (fd) => {
    let r = {}
    if (!fs.existsSync(fd)) {
        return r
    }
    for (let f of fs.readdirSync(fd).sort()) {
        r[f] = fs.readFileSync(path.join(fd, f), 'utf8')
    }
    return r
}
let todayOf = (tz) => ot.tz(Date.now(), tz).format('YYYY-MM-DD')
let daysBack = (tz, n) => ot.tz(`${todayOf(tz)}T00:00:00`, tz).add(-n, 'day').format('YYYY-MM-DD')

//expectAgg, 依規格算出合併序列: 各分段之目標根(已收棒加寬限者)與未輸出之最新目標根
let expectAgg = ({ type, key, tz, dayStart, grace = 60000, now = Date.now() }) => {
    let t = SEC[key] * 1000
    let LT = SEG_H[key] * H
    let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
    let off = ot.tz(t0, tz).utcOffset() * M
    let phase = (key === '1week' ? 4 * D : 0) - off
    let kLatest = Math.floor((now - t0) / LT)
    let segs = {}
    let opens = []
    for (let k = 0; k <= kLatest; k++) {
        let S = t0 + k * LT
        let tag = ot.tz(S, tz).format('YYYYMMDDHHmmss')
        let rows = []
        let first = S + (((phase - S) % t) + t) % t
        for (let o = first; o < S + LT; o += t) {
            if (o + t + grace <= now) {
                rows.push(oracleRow(type, o, t, tz))
                opens.push(o)
            }
        }
        if (rows.length > 0) {
            segs[`${tag}.csv`] = rows.join('\n')
        }
    }
    return { segs, opens, t, t0, LT, kLatest }
}

//quiet, 執行期間收集 console.log
let quiet = async (fn) => {
    let logs = []
    let log = console.log
    console.log = (...args) => {
        logs.push(args.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '))
    }
    try {
        await fn()
    }
    finally {
        console.log = log
    }
    return logs
}

//T0, 測試之「現在」(假時鐘, 每案開始時重設): 台北 2026-11-20(週五) 10:00, 與各案所用之界線皆有距離; 時鐘於各案內不前進, 只在案內明設
let T0 = Date.parse('2026-11-20T02:00:00Z')

//dsOf, dayStart 之 YYYYMMDD(資料夾名之一部分)
let dsOf = (dayStart) => dayStart.split('-').join('')

let supportsOffsetTz = () => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: '+08:00' })
        return true
    }
    catch (err) {
        return false
    }
}


describe('api-saveDataAggregate', function() {

    before(async function() {
        install(T0)
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdRoot, { recursive: true })
        server = http.createServer((req, res) => {
            let u = new URL(req.url, 'http://127.0.0.1')
            let type = u.pathname.split('/')[1]
            let q = {
                type,
                startTime: Number(u.searchParams.get('startTime')),
                endTime: Number(u.searchParams.get('endTime')),
                interval: u.searchParams.get('interval'),
                keys: [...u.searchParams.keys()].sort().join(','),
                at: Date.now(),
            }
            reqs.push(q)
            if (EX_SEC[q.interval] === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ code: -1120, msg: 'Invalid interval.' }))
                return
            }
            if (mode.status500.has(`${type}|${q.interval}|${q.startTime}`)) {
                res.writeHead(500)
                res.end('error')
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(barsOf(type, q.interval, q.startTime, q.endTime, q.at)))
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        port = server.address().port
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

    it('G1 台北之 1day(預設): 下載 8hr 合併 3 根, 各根為當地 00:00 至 24:00, 存於獨立資料夾; 未收之當日不輸出並列入 missing', async function() {
        //規格: aggregateFrom 未給時新增之週期鍵為 'auto'; 不對齊者取能整除且對齊之最大原生週期(UTC+8 之 1day 為 8hr 合併 3 根); 合併之序列存於 '<週期鍵>_tz<±HHMM>_d<dayStart>_from<基底>', 基底存於 '<基底>_tz<±HHMM>_d<dayStart>'(不與直接下載之資料夾共用); 未收棒者不輸出, 記入 aggregate.missing
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 2 * 48 + 15)
        let name = 'G1'
        let r = await run(name, 'price', '1day', { dayStart, timeZone: tz })
        let tEnd = Date.now()
        //請求皆為 8h, 不帶 timeZone
        assert.ok(reqs.length > 0)
        assert.ok(reqs.every((v) => v.interval === '8h' && v.keys === 'endTime,interval,limit,startTime,symbol'), JSON.stringify(reqs.map((v) => v.interval)))
        //回傳之 aggregate
        assert.deepStrictEqual({ ...r.aggregate, segments: undefined, missing: undefined }, {
            key: `1day_tz+0800_d${dsOf(dayStart)}_from8hr`,
            base: '8hr',
            baseKey: `8hr_tz+0800_d${dsOf(dayStart)}`,
            count: 3,
            utcOffset: 480,
            fd: fdOf(name, 'price', `1day_tz+0800_d${dsOf(dayStart)}_from8hr`),
            segments: undefined,
            missing: undefined,
        })
        //基底存於帶偏移與 dayStart 之獨立資料夾, 直接下載之 8hr、1day 資料夾皆不存在
        assert.ok(Object.keys(readTree(fdOf(name, 'price', `8hr_tz+0800_d${dsOf(dayStart)}`))).length > 0)
        assert.deepStrictEqual(fs.readdirSync(path.resolve(fdRoot, name, 'price')).sort(), [`1day_tz+0800_d${dsOf(dayStart)}_from8hr`, `8hr_tz+0800_d${dsOf(dayStart)}`])
        //合併序列與對照解逐位相同(以本輪結束時刻判定已收棒之目標根)
        let ex = expectAgg({ type: 'price', key: '1day', tz, dayStart, now: tEnd })
        let tree = readTree(r.aggregate.fd)
        assert.deepStrictEqual(Object.keys(tree), Object.keys(ex.segs))
        for (let f of Object.keys(ex.segs)) {
            assert.strictEqual(tree[f], ex.segs[f], f)
        }
        //舊段皆 48 根, 各根開於當地 00:00, 結束於當地 23:59:59
        let files = Object.keys(tree)
        for (let f of files.slice(0, -1)) {
            let rows = tree[f].split('\n')
            assert.strictEqual(rows.length, 48, f)
            for (let row of rows) {
                let c = row.split(', ')
                assert.strictEqual(c[0].slice(11), '00:00:00')
                assert.strictEqual(c[6].slice(11), '23:59:59')
                assert.strictEqual(ot.tz(c[6], tz).valueOf() + 1000 - ot.tz(c[0], tz).valueOf(), D)
            }
        }
        //當日(未收)不輸出, missing 只有當日且 reason 為 open
        let today = ot.tz(`${todayOf(tz)}T00:00:00`, tz).valueOf()
        assert.deepStrictEqual(r.aggregate.missing.map((v) => [v.time, v.need, v.reason]), [[fmtOf(tz)(today), 3, 'open']])
        assert.ok(r.aggregate.missing[0].have >= 1 && r.aggregate.missing[0].have <= 3)
        //timeLast、timeKeep 為最新兩根已輸出之目標根
        assert.strictEqual(r.timeLast, fmtOf(tz)(today - D))
        assert.strictEqual(r.timeKeep, fmtOf(tz)(today - 2 * D))
        //segments 列出本次重算之各段
        assert.deepStrictEqual(r.aggregate.segments.map((v) => `${v.tag}.csv`), files)

        //第二輪: 基底只抓最新段, 合併只重算最新段, 內容不變
        let r2 = await run(name, 'price', '1day', { dayStart, timeZone: tz })
        assert.strictEqual(reqs.length, 1)
        assert.deepStrictEqual(r2.aggregate.segments.map((v) => `${v.tag}.csv`), [files[files.length - 1]])
        let tree2 = readTree(r.aggregate.fd)
        for (let f of files.slice(0, -1)) {
            assert.strictEqual(tree2[f], tree[f], f)
        }
    })

    it('G2 台北之 1day 由 8hr、4hr、1hr 合併者逐位相同, 且與逐分鐘聚合之對照解相同', async function() {
        //規格: 合併之規則(開=首根之開、高=最高、低=最低、收=末根之收、量與額與筆數=十進位精確加總); aggregateFrom 可指定基底週期鍵
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 48 + 5)
        let name = 'G2'
        let trees = {}
        for (let af of ['auto', '8hr', '4hr', '1hr']) {
            let r = await run(name, 'price', '1day', { dayStart, timeZone: tz, aggregateFrom: af })
            let base = af === 'auto' ? '8hr' : af
            assert.strictEqual(r.aggregate.key, `1day_tz+0800_d${dsOf(dayStart)}_from${base}`, af)
            assert.strictEqual(r.aggregate.count, 86400 / SEC[base], af)
            assert.ok(reqs.every((v) => v.interval === { '8hr': '8h', '4hr': '4h', '1hr': '1h' }[base]), af)
            trees[af] = readTree(r.aggregate.fd)
        }
        let ex = expectAgg({ type: 'price', key: '1day', tz, dayStart })
        for (let af of ['8hr', '4hr', '1hr']) {
            assert.deepStrictEqual(trees[af], trees.auto, af)
        }
        assert.deepStrictEqual(Object.keys(trees.auto), Object.keys(ex.segs))
        for (let f of Object.keys(ex.segs)) {
            assert.strictEqual(trees.auto[f], ex.segs[f], f)
        }
        //第一段為完整之 48 根
        assert.strictEqual(Object.values(trees.auto)[0].split('\n').length, 48)
    })

    for (let [tz, base, count, label] of [['Asia/Tokyo', '1hr', 24, '+0900'], ['Asia/Kolkata', '30m', 48, '+0530'], ['Asia/Kathmandu', '15m', 96, '+0545'], ['Etc/GMT+5', '1hr', 24, '-0500']]) {

        it(`G3 ${tz} 之 1day: 以 ${base} 合併 ${count} 根, 各根以當地 00:00 起訖、每根 24 小時`, async function() {
            //規格: UTC+9 之 1day 為 1hr 合併 24 根、UTC+5:30 為 30m 合併 48 根(UTC+5:45 為 15m); 固定偏移之 IANA 寫法(Etc/GMT+5 = UTC-5)可用; 各根之時長恆為該週期之秒數
            let dayStart = daysBack(tz, 3)
            let name = `G3_${label}`
            let r = await run(name, 'price', '1day', { dayStart, timeZone: tz })
            let tEnd = Date.now()
            assert.strictEqual(r.aggregate.key, `1day_tz${label}_d${dsOf(dayStart)}_from${base}`)
            assert.strictEqual(r.aggregate.count, count)
            let ex = expectAgg({ type: 'price', key: '1day', tz, dayStart, now: tEnd })
            let tree = readTree(r.aggregate.fd)
            assert.deepStrictEqual(tree, ex.segs)
            let rows = Object.values(tree).join('\n').split('\n')
            assert.ok(rows.length >= 2)
            for (let row of rows) {
                let c = row.split(', ')
                assert.strictEqual(c[0].slice(11), '00:00:00')
                assert.strictEqual(ot.tz(c[6], tz).valueOf() + 1000 - ot.tz(c[0], tz).valueOf(), D)
            }
        })

    }

    it('G3b 固定偏移字串(+08:00): 執行環境支援者與 Asia/Taipei 得相同之資料夾名與內容, 不支援者拋專屬之錯誤', async function() {
        //規格: timeZone 可給固定偏移(如 '+08:00'), 須執行環境之 Intl 支援, 不支援時與無效時區同訊息(IANA 時區名)
        let dayStart = daysBack('Asia/Taipei', 3)
        if (!supportsOffsetTz()) {
            await assert.rejects(run('G3b_b', 'price', '1day', { dayStart, timeZone: '+08:00' }), (err) => err.message === `invalid opt.timeZone: must be an IANA time zone name on this runtime, e.g. 'Etc/GMT-8'`)
            assert.strictEqual(fs.existsSync(path.resolve(fdRoot, 'G3b_b')), false)
            return
        }
        let r1 = await run('G3b_a', 'price', '1day', { dayStart, timeZone: 'Asia/Taipei' })
        let r2 = await run('G3b_b', 'price', '1day', { dayStart, timeZone: '+08:00' })
        assert.strictEqual(r2.aggregate.key, r1.aggregate.key)
        assert.deepStrictEqual(readTree(r2.aggregate.fd), readTree(r1.aggregate.fd))
    })

    let hours = (step) => {
        let r = []
        for (let h = 0; h < 24; h += step) {
            r.push(`${String(h).padStart(2, '0')}:00:00`)
        }
        return r
    }

    for (let [key, tz, base, count, hhmm] of [['12hr', 'Asia/Taipei', '4hr', 3, ['00:00:00', '12:00:00']], ['6hr', 'Asia/Taipei', '2hr', 3, ['00:00:00', '06:00:00', '12:00:00', '18:00:00']], ['1week', 'Asia/Taipei', '8hr', 21, ['00:00:00']], ['4hr', 'Asia/Kolkata', '30m', 8, hours(4)], ['4hr', 'Asia/Tokyo', '1hr', 4, hours(4)], ['1hr', 'Asia/Kolkata', '30m', 2, hours(1)], ['1hr', 'Asia/Kathmandu', '15m', 4, hours(1)]]) {

        it(`G4 ${key} ${tz}: 以 ${base} 合併 ${count} 根, 各根以當地界線起訖`, async function() {
            //規格: 不對齊之週期依時區之界線合併(12hr 為當地 00:00、12:00; 1week 為當地週一 00:00); aggregateFrom 未給為 'auto', 既有六鍵之 1hr、4hr 於目標未對齊之時區(UTC+5:30、UTC+5:45、UTC+9)亦合併
            let dayStart = daysBack(tz, key === '1week' ? 30 : (key === '4hr' || key === '1hr' ? 2 : 6))
            let name = `G4_${key}_${tz.replace('/', '_')}`
            let opt = { dayStart, timeZone: tz }
            let r = await run(name, 'price', key, opt)
            let tEnd = Date.now()
            assert.strictEqual(r.aggregate.base, base)
            assert.strictEqual(r.aggregate.count, count)
            let ex = expectAgg({ type: 'price', key, tz, dayStart, now: tEnd })
            let tree = readTree(r.aggregate.fd)
            assert.deepStrictEqual(tree, ex.segs)
            let rows = Object.values(tree).join('\n').split('\n')
            assert.ok(rows.length >= 2)
            for (let row of rows) {
                let c = row.split(', ')
                assert.ok(hhmm.indexOf(c[0].slice(11)) >= 0, c[0])
                assert.strictEqual(ot.tz(c[6], tz).valueOf() + 1000 - ot.tz(c[0], tz).valueOf(), SEC[key] * 1000)
                if (key === '1week') {
                    assert.strictEqual(ot.tz(c[0], tz).day(), 1)
                }
            }
        })

    }

    it('G5 對齊者直接下載原生週期(台北之 4hr、8hr、UTC 之 1day、有日光節約之時區之 1hr、3m)', async function() {
        //規格: 原生格線與 timeZone 之界線對齊者(各偏移下皆對齊, 有日光節約之時區亦可)直接下載, 存於 '<週期鍵>' 資料夾, 回傳不含 aggregate; aggregateFrom 未給為 'auto'(不分週期鍵)
        for (let [key, tz, ex, ds] of [['8hr', 'Asia/Taipei', '8h', 20], ['4hr', 'Asia/Taipei', '4h', 10], ['1day', 'UTC', '1d', 60], ['1hr', 'America/New_York', '1h', 10], ['3m', 'America/New_York', '3m', 1]]) {
            let name = `G5_${key}_${tz.replace('/', '_')}`
            let r = await run(name, 'price', key, { dayStart: daysBack(tz, ds), timeZone: tz })
            assert.strictEqual(r.aggregate, undefined, `${key} ${tz}`)
            assert.deepStrictEqual(Object.keys(r).sort(), ['items', 'timeKeep', 'timeLast'], `${key} ${tz}`)
            assert.ok(reqs.length > 0 && reqs.every((v) => v.interval === ex), `${key} ${tz}`)
            assert.deepStrictEqual(fs.readdirSync(path.resolve(fdRoot, name, 'price')), [key], `${key} ${tz}`)
        }
    })

    it('G6 原生之 1day(aggregateFrom none)與合併之 1day 存於不同資料夾, 互不覆蓋', async function() {
        //規格: 合併之序列與其基底皆存於帶偏移與 dayStart 之資料夾, 與原生之 '<週期鍵>' 資料夾分開, 不互相覆蓋
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 60)
        let name = 'G6'
        await run(name, 'price', '1day', { dayStart, timeZone: tz, aggregateFrom: 'none' })
        let native1 = readTree(fdOf(name, 'price', '1day'))
        let ra = await run(name, 'price', '1day', { dayStart, timeZone: tz })
        let agg1 = readTree(ra.aggregate.fd)
        await run(name, 'price', '1day', { dayStart, timeZone: tz, aggregateFrom: 'none' })
        let native2 = readTree(fdOf(name, 'price', '1day'))
        let agg2 = readTree(ra.aggregate.fd)
        assert.deepStrictEqual(fs.readdirSync(path.resolve(fdRoot, name, 'price')).sort(), ['1day', `1day_tz+0800_d${dsOf(dayStart)}_from8hr`, `8hr_tz+0800_d${dsOf(dayStart)}`])
        //原生之各根開於 08:00(UTC 00:00), 合併之各根開於 00:00
        assert.ok(Object.values(native1).join('\n').split('\n').every((v) => v.slice(11, 19) === '08:00:00'))
        assert.ok(Object.values(agg1).join('\n').split('\n').every((v) => v.slice(11, 19) === '00:00:00'))
        //舊段不因另一方式之執行而改變
        let olds = (tr) => Object.keys(tr).slice(0, -1).map((f) => tr[f])
        assert.deepStrictEqual(olds(native2), olds(native1))
        assert.deepStrictEqual(olds(agg2), olds(agg1))
    })

    it('G7 參數無效時拋錯, 不建夾、不發請求', async function() {
        //規格: aggregateFrom 須為 'auto'、'none' 或週期鍵; 基底須能整除目標週期且格線與 timeZone 之界線對齊; 合併時 timeZone 須為固定偏移; 參數無效時於任何連網、建夾、寫檔前拋錯
        let tz = 'Asia/Taipei'
        let afMsg = `invalid opt.aggregateFrom: must be one of auto, none, ${Object.keys(SEG_H).join(', ')}`
        let alignMsg = 'invalid opt.aggregateFrom: must be an interval that divides interval and aligns with the boundaries of timeZone'
        let ianaMsg = `invalid opt.timeZone: must be an IANA time zone name on this runtime, e.g. 'Etc/GMT-8'`
        let smallMsg = 'invalid opt.timeZone: must be zero or a UTC offset of at least 30 minutes'
        let cases = [
            ['1day', { timeZone: tz, aggregateFrom: 'abc' }, afMsg],
            ['1day', { timeZone: tz, aggregateFrom: 8 }, afMsg],
            ['1day', { timeZone: tz, aggregateFrom: '' }, afMsg],
            ['1day', { timeZone: tz, aggregateFrom: 'toString' }, afMsg],
            ['1day', { timeZone: 'UTC', aggregateFrom: 'abc' }, afMsg], //對齊(本可直接下載)者亦拋
            ['4hr', { timeZone: tz, aggregateFrom: true }, afMsg], //既有六鍵亦同
            ['4hr', { timeZone: tz, aggregateFrom: '1d' }, afMsg],
            ['1day', { timeZone: tz, aggregateFrom: '12hr' }, alignMsg],
            ['12hr', { timeZone: tz, aggregateFrom: '8hr' }, alignMsg],
            ['1day', { timeZone: tz, aggregateFrom: '1week' }, alignMsg],
            ['1day', { timeZone: tz, aggregateFrom: '1day' }, alignMsg],
            ['1hr', { timeZone: 'Asia/Kolkata', aggregateFrom: '1hr' }, alignMsg], //既有六鍵之 1hr 於 UTC+5:30 不對齊, 指定自身為基底
            ['1day', { timeZone: 'Bad/Zone' }, ianaMsg],
            ['4hr', { timeZone: 'Bad/Zone' }, ianaMsg], //既有六鍵與 none 亦先檢測時區
            ['4hr', { timeZone: 'Bad/Zone', aggregateFrom: 'none' }, ianaMsg],
            ['1day', { timeZone: '+00:15' }, supportsOffsetTz() ? smallMsg : ianaMsg],
        ]
        for (let [key, opt, msg] of cases) {
            let name = 'G7'
            await assert.rejects(run(name, 'price', key, { dayStart: daysBack(tz, 10), ...opt }), (err) => err.message === msg, `${key} ${JSON.stringify(opt)}`)
            assert.strictEqual(reqs.length, 0)
            assert.strictEqual(fs.existsSync(path.resolve(fdRoot, name)), false)
        }
        //undefined 與 null 視為未給: 照預設('auto')執行
        for (let af of [undefined, null]) {
            let r = await run('G7ok', 'price', '1day', { dayStart: daysBack(tz, 3), timeZone: tz, aggregateFrom: af, useDryRun: true })
            assert.strictEqual(r.aggregate.base, '8hr', String(af))
        }
    })

    it('G8 有日光節約之時區: 須合併者拋錯(含不跨轉換日之短期間), 原生格線於各偏移下皆對齊者直接下載; 期間內偏移有變動之 IANA 時區亦同; 無變動者通過', async function() {
        //規格: 須合併時 timeZone 須於資料期間(dayStart 至現在後 1 年)內為固定偏移, 有日光節約時間或偏移變動者拋錯; 'auto'(預設, 含既有六鍵)而原生格線於各偏移下皆對齊者(例如有日光節約之時區之 3m、1hr)為直接下載, 不要求固定偏移; 明給 'none' 為原生格線(不要求固定偏移)
        let msg = `invalid opt.timeZone: must be a fixed-offset time zone without daylight saving time, e.g. 'Etc/GMT+5' or '-05:00'`
        let cases = [
            ['1day', 'America/New_York', daysBack('America/New_York', 400)], //跨多次轉換
            ['1day', 'America/New_York', daysBack('America/New_York', 2)], //短期間, 未來 1 年內有轉換
            ['12hr', 'Europe/London', daysBack('Europe/London', 2)],
            ['1day', 'Asia/Taipei', '1975-01-01'], //期間內有歷史上之日光節約(1979 年以前)
            ['4hr', 'America/New_York', daysBack('America/New_York', 2), 'auto'],
            ['4hr', 'America/New_York', daysBack('America/New_York', 2)], //既有六鍵未給 aggregateFrom 時亦須合併而拋錯(1.0.58 為直接下載)
            ['4hr', 'Asia/Taipei', '1975-01-01'], //dayStart 早於 1980 之台北(期間內曾有日光節約: 偏移 480 與 540), 既有六鍵之 4hr 於 540 不對齊而須合併
            ['1day', 'America/New_York', daysBack('America/New_York', 2), '1hr'],
        ]
        for (let [key, tz, dayStart, af] of cases) {
            let opt = { dayStart, timeZone: tz }
            if (af) {
                opt.aggregateFrom = af
            }
            await assert.rejects(run('G8', 'price', key, opt), (err) => err.message === msg, `${key} ${tz} ${dayStart}`)
            assert.strictEqual(reqs.length, 0)
            assert.strictEqual(fs.existsSync(path.resolve(fdRoot, 'G8')), false)
        }
        //原生格線於各偏移下皆對齊者直接下載(New_York 之 -5 與 -4 小時皆為 3m、1hr 之整數倍)
        for (let [key, af, ex] of [['3m', undefined, '3m'], ['1hr', 'auto', '1h'], ['1hr', undefined, '1h'], ['30m', undefined, '30m'], ['2hr', 'auto', '2h'], ['4hr', 'none', '4h']]) {
            let tz = 'America/New_York'
            let opt = { dayStart: daysBack(tz, 1), timeZone: tz }
            if (af) {
                opt.aggregateFrom = af
            }
            let name = `G8n_${key}_${af}`
            if (key === '2hr') {
                //-5 小時非 2 小時之整數倍 ⇒ 須合併 ⇒ 拋錯
                await assert.rejects(run(name, 'price', key, opt), (err) => err.message === msg, key)
                assert.strictEqual(fs.existsSync(path.resolve(fdRoot, name)), false)
                continue
            }
            let r = await run(name, 'price', key, opt)
            assert.strictEqual(r.aggregate, undefined, key)
            assert.ok(reqs.length > 0 && reqs.every((v) => v.interval === ex), key)
            assert.deepStrictEqual(fs.readdirSync(path.resolve(fdRoot, name, 'price')), [key])
        }
        //無變動者通過(Asia/Taipei 自 2020 年起無變動)
        let r = await run('G8ok', 'price', '1day', { dayStart: daysBack('Asia/Taipei', 3), timeZone: 'Asia/Taipei', useDryRun: true })
        assert.strictEqual(r.aggregate.utcOffset, 480)
    })

    it('G9 基底缺漏(gap)、基底擷取於收棒前且重抓失敗(notFinal)、基底數值無法解析(invalidBase)之目標根不輸出並列入 missing; 補齊後輸出', async function() {
        //規格: 某目標根之基底各根不齊、未收棒或擷取於收棒前者不輸出, 記入 aggregate.missing { time, have, need, reason }
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 48 + 15)
        let name = 'G9'
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let fmt = fmtOf(tz)
        //gap: 第 3 天(當地)之第 2 根 8h 不回傳
        let dGap = t0 + 2 * D
        mode.drop.add(`price|8h|${dGap + 8 * H}`)
        try {
            let r = await run(name, 'price', '1day', { dayStart, timeZone: tz })
            let miss = r.aggregate.missing.filter((v) => v.reason !== 'open')
            assert.deepStrictEqual(miss, [{ time: fmt(dGap), have: 2, need: 3, reason: 'gap' }])
            let rows0 = fs.readFileSync(`${r.aggregate.fd}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`, 'utf8').split('\n')
            assert.strictEqual(rows0.length, 47)
            assert.ok(rows0.every((v) => v.slice(0, 19) !== fmt(dGap)))
        }
        finally {
            mode.drop.clear()
        }
        //補齊: 基底之該段(筆數不符)於下輪重抓, 合併後輸出該日
        let r2 = await run(name, 'price', '1day', { dayStart, timeZone: tz })
        assert.deepStrictEqual(r2.aggregate.missing.filter((v) => v.reason !== 'open'), [])
        let fp0 = `${r2.aggregate.fd}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`
        assert.strictEqual(fs.readFileSync(fp0, 'utf8').split('\n').length, 48)

        //notFinal: 基底第 1 段(16 天)之末根改為擷取於收棒前之值, 其重抓回 500
        let fdBase = fdOf(name, 'price', r2.aggregate.baseKey)
        let tagB0 = ot.tz(t0, tz).format('YYYYMMDDHHmmss')
        let fpB0 = `${fdBase}/${tagB0}.csv`
        let rowsB = fs.readFileSync(fpB0, 'utf8').split('\n')
        let lastOpen = t0 + 16 * D - 8 * H
        let c = rowsB[rowsB.length - 1].split(', ')
        c[4] = '1.00000000'
        rowsB[rowsB.length - 1] = c.join(', ')
        fs.writeFileSync(fpB0, rowsB.join('\n'), 'utf8')
        fs.utimesSync(fpB0, new Date(), new Date(lastOpen + 3600e3))
        //合併分段檔不存在(例如首次合併時)才會以此基底重算; 基底檔之修改時間早於既有合併檔時視為未變
        fs.rmSync(fp0)
        mode.status500.add(`price|8h|${t0}`)
        try {
            let r3 = await run(name, 'price', '1day', { dayStart, timeZone: tz })
            assert.deepStrictEqual(r3.aggregate.missing.filter((v) => v.reason !== 'open'), [{ time: fmt(t0 + 15 * D), have: 3, need: 3, reason: 'notFinal' }])
            assert.strictEqual(fs.readFileSync(fp0, 'utf8').split('\n').length, 47)
        }
        finally {
            mode.status500.clear()
        }

        //invalidBase: 基底第 1 段之第 4 根之量欄無法解析(末列完整故基底判完整)
        let r4 = await run(name, 'price', '1day', { dayStart, timeZone: tz })
        assert.deepStrictEqual(r4.aggregate.missing.filter((v) => v.reason !== 'open'), [])
        rowsB = fs.readFileSync(fpB0, 'utf8').split('\n')
        c = rowsB[3].split(', ')
        c[5] = 'abc'
        rowsB[3] = c.join(', ')
        //修改時間設為既有合併檔之修改時間後 2 秒(晚於合併檔故須重算; 且晚於基底末根之收棒加寬限, 故基底判完整而不重抓)
        fs.writeFileSync(fpB0, rowsB.join('\n'), 'utf8')
        fs.utimesSync(fpB0, new Date(), new Date(fs.statSync(fp0).mtimeMs + 2000))
        let r5 = await run(name, 'price', '1day', { dayStart, timeZone: tz })
        assert.deepStrictEqual(r5.aggregate.missing.filter((v) => v.reason !== 'open'), [{ time: fmt(t0 + D), have: 3, need: 3, reason: 'invalidBase' }])
        assert.deepStrictEqual(r5.items.map((v) => v.reason), ['latest'])
    })

    it('G10 早於最早一根基底資料(上市前)之目標根不列入 missing', async function() {
        //規格: 早於最早一根基底資料之目標根不列入 missing
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 10)
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        mode.listing = t0 + 4 * D + 8 * H //第 5 天之第 2 根起才有資料
        try {
            let r = await run('G10', 'price', '1day', { dayStart, timeZone: tz })
            let fmt = fmtOf(tz)
            //第 5 天缺第 1 根(上市日當天)列為 gap, 前 4 天不列
            assert.deepStrictEqual(r.aggregate.missing.filter((v) => v.reason !== 'open'), [{ time: fmt(t0 + 4 * D), have: 2, need: 3, reason: 'gap' }])
            let rows = Object.values(readTree(r.aggregate.fd)).join('\n').split('\n')
            assert.strictEqual(rows[0].slice(0, 19), fmt(t0 + 5 * D))
        }
        finally {
            mode.listing = 0
        }
    })

    it('G11 乾跑: 不發請求、不寫檔, items 列出基底將下載之分段, aggregate 之 segments 與 missing 為空', async function() {
        //規格: useDryRun 時不發請求亦不寫檔; 合併時 items 為基底週期之分段; 乾跑時不合併
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 40)
        let r = await run('G11', 'price', '1day', { dayStart, timeZone: tz, useDryRun: true })
        assert.strictEqual(reqs.length, 0)
        assert.strictEqual(fs.existsSync(fdOf('G11', 'price', `1day_tz+0800_d${dsOf(dayStart)}_from8hr`)), false)
        assert.strictEqual(fs.existsSync(fdOf('G11', 'price', `8hr_tz+0800_d${dsOf(dayStart)}`)), true) //基底資料夾由既有機制建立(同 1.0.58 乾跑之行為)
        assert.deepStrictEqual(fs.readdirSync(fdOf('G11', 'price', `8hr_tz+0800_d${dsOf(dayStart)}`)), [])
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let n = Math.floor((Date.now() - t0) / (16 * D)) + 1
        assert.strictEqual(r.items.length, n)
        assert.ok(r.items.every((v, i) => v.reason === (i === 0 ? 'latest' : 'notExist')))
        assert.deepStrictEqual(r.aggregate.segments, [])
        assert.deepStrictEqual(r.aggregate.missing, [])
        assert.strictEqual(r.timeLast, undefined)
    })

    it('G12 溢價指數(負值、量欄為 0)以相同選項得同一基底與界線, 內容與對照解相同', async function() {
        //規格: 基底由週期鍵、timeZone 與 aggregateFrom 決定, 與端點無關, 故價格與溢價指數以相同選項呼叫時用同一基底與界線
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 20)
        let rp = await run('G12', 'price', '1day', { dayStart, timeZone: tz })
        let ri = await run('G12', 'index', '1day', { dayStart, timeZone: tz })
        let tEnd = Date.now()
        assert.strictEqual(ri.aggregate.key, rp.aggregate.key)
        assert.strictEqual(ri.aggregate.base, rp.aggregate.base)
        let ex = expectAgg({ type: 'index', key: '1day', tz, dayStart, now: tEnd })
        let tree = readTree(ri.aggregate.fd)
        assert.deepStrictEqual(tree, ex.segs)
        let rows = Object.values(tree).join('\n').split('\n')
        assert.ok(rows.some((v) => v.split(', ')[3].startsWith('-')))
        assert.ok(rows.every((v) => v.split(', ')[5] === '0'))
        //價格與溢價指數之各根開盤時刻相同
        let opensOf = (tr) => Object.values(tr).join('\n').split('\n').map((v) => v.slice(0, 19))
        assert.deepStrictEqual(opensOf(tree), opensOf(readTree(rp.aggregate.fd)))
    })

    it('G14 syncData 透傳 aggregateFrom 至 saveData', async function() {
        //規格: syncData 之 opt.aggregateFrom 給予時透傳給 saveData
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 3)
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let fp = path.resolve(fdRoot, 'G14', 'price', `1day_tz+0800_d${dsOf(dayStart)}_from4hr`, `${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`)
        reqs = []
        let p = syncData('G14', 'price', epOf('price'), 'TESTUSDT', { interval: '1day', dayStart, timeZone: tz, aggregateFrom: '4hr', fdData: fdRoot, timeSyncInterval: 3600 * 1000 })
        p.run()
        try {
            //同步點: 合併分段檔寫出(步進式檢查, 防懸置上限 60 秒)
            await new Promise((resolve, reject) => {
                let guard = setTimeout(() => {
                    clearInterval(iv)
                    reject(new Error('timeout'))
                }, 60 * 1000)
                let iv = setInterval(() => {
                    if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').split('\n').length >= 2) {
                        clearInterval(iv)
                        clearTimeout(guard)
                        resolve()
                    }
                }, 100)
            })
        }
        finally {
            p.stop()
        }
        assert.ok(reqs.length > 0 && reqs.every((v) => v.interval === '4h'), JSON.stringify(reqs.map((v) => v.interval)))
    })

    it('G15 收棒加寬限之邊界: 收棒後寬限內(30 秒、寬限前 1 毫秒)不輸出並列為 open, 恰到寬限時輸出; timeGrace 為 0 時收棒即輸出', async function() {
        //規格: 某目標根之基底各根未收棒加寬限(opt.timeGrace, 預設 60000)者不輸出, 記入 aggregate.missing(目標根之收棒加寬限晚於現在者 reason 為 open)
        let tz = 'Asia/Taipei'
        let fmt = fmtOf(tz)
        let mid = Date.parse('2026-11-20T00:00:00+08:00') //當地 00:00 = 前一日(11-19)之名目收棒
        let dayStart = '2026-11-16'
        let prev = fmt(mid - D)
        let rowsOf = (r) => Object.values(readTree(r.aggregate.fd)).join('\n').split('\n').filter((v) => v !== '')
        for (let [dt, out] of [[30 * 1000, false], [60 * 1000 - 1, false], [60 * 1000, true]]) {
            setNow(mid + dt)
            let r = await run('G15', 'price', '1day', { dayStart, timeZone: tz })
            assert.strictEqual(rowsOf(r).some((v) => v.slice(0, 19) === prev), out, `+${dt}ms`)
            assert.deepStrictEqual(r.aggregate.missing.filter((v) => v.time === prev), out ? [] : [{ time: prev, have: 3, need: 3, reason: 'open' }], `+${dt}ms`)
        }
        setNow(mid)
        let r0 = await run('G15g0', 'price', '1day', { dayStart, timeZone: tz, timeGrace: 0 })
        assert.ok(rowsOf(r0).some((v) => v.slice(0, 19) === prev))
        assert.deepStrictEqual(r0.aggregate.missing.filter((v) => v.time === prev), [])
    })

    it('G16 同一 fdData 下直接下載基底之週期(不同時區或不同 dayStart)與合併並存: 各用各的資料夾, 合併結果正確, 直接下載之內容不受影響, 各資料夾無重複之根', async function() {
        //規格: 合併所用之基底與合併之輸出皆不與直接下載之 '<週期鍵>' 資料夾共用; 資料夾名含偏移與 dayStart, 以不同時區或不同 dayStart 呼叫者不會互相覆蓋或錯位
        let tz = 'Asia/Taipei'
        //C1: 先以 UTC 直接下載 8hr, 再以台北合併 1day(同一 dayStart 字串)
        let name = 'G16'
        let dayStart = daysBack(tz, 50)
        await run(name, 'price', '8hr', { dayStart, timeZone: 'UTC' })
        let native8 = readTree(fdOf(name, 'price', '8hr'))
        let r1 = await run(name, 'price', '1day', { dayStart, timeZone: tz })
        assert.deepStrictEqual(readTree(r1.aggregate.fd), expectAgg({ type: 'price', key: '1day', tz, dayStart }).segs)
        assert.deepStrictEqual(readTree(fdOf(name, 'price', '8hr')), native8)
        for (let row of Object.values(native8).join('\n').split('\n')) {
            let c = row.split(', ')
            let o = Date.parse(`${c[0]}Z`)
            let x = aggMin('price', o, o + 8 * H, Date.now())
            assert.ok(c[1] === fmt8(x.o) && c[4] === fmt8(x.c), c[0])
        }
        //C2: 同時區不同 dayStart: 直接下載 8hr(dayStart A)、合併 1day(dayStart B)、合併 1day(dayStart A)
        let name2 = 'G16b'
        let dsA = daysBack(tz, 50)
        let dsB = daysBack(tz, 46)
        await run(name2, 'price', '8hr', { dayStart: dsA, timeZone: tz })
        let rB = await run(name2, 'price', '1day', { dayStart: dsB, timeZone: tz })
        let rA = await run(name2, 'price', '1day', { dayStart: dsA, timeZone: tz })
        assert.deepStrictEqual(fs.readdirSync(path.resolve(fdRoot, name2, 'price')).sort(), [`1day_tz+0800_d${dsOf(dsA)}_from8hr`, `1day_tz+0800_d${dsOf(dsB)}_from8hr`, '8hr', `8hr_tz+0800_d${dsOf(dsA)}`, `8hr_tz+0800_d${dsOf(dsB)}`].sort())
        for (let f of fs.readdirSync(path.resolve(fdRoot, name2, 'price'))) {
            let opens = Object.values(readTree(fdOf(name2, 'price', f))).join('\n').split('\n').filter((v) => v !== '').map((v) => v.slice(0, 19))
            assert.strictEqual(new Set(opens).size, opens.length, f)
        }
        assert.deepStrictEqual(readTree(rB.aggregate.fd), expectAgg({ type: 'price', key: '1day', tz, dayStart: dsB }).segs)
        assert.deepStrictEqual(readTree(rA.aggregate.fd), expectAgg({ type: 'price', key: '1day', tz, dayStart: dsA }).segs)
        //getIntervalPlan 預先得知之資料夾名與回傳一致
        assert.strictEqual(getIntervalPlan('1day', { timeZone: tz, dayStart: dsA }).key, rA.aggregate.key)
        assert.strictEqual(getIntervalPlan('1day', { timeZone: tz, dayStart: dsA }).baseKey, rA.aggregate.baseKey)
    })

    it('G17 syncData 於建立時檢查週期鍵、取得方式與時區: 無效即拋且不建夾、不啟動計時器(含既有六鍵)', function() {
        //規格: syncData 於建立時以 getIntervalPlan 檢查(週期鍵、aggregateFrom 給了而無效、timeZone; 無效即拋, 先於任何副作用); aggregateFrom 未給為 'auto', 不分週期鍵
        let mk = (opt) => syncData('G17', 'price', epOf('price'), 'TESTUSDT', { fdData: fdRoot, ...opt })
        let afMsg = `invalid opt.aggregateFrom: must be one of auto, none, ${Object.keys(SEG_H).join(', ')}`
        let dstMsg = `invalid opt.timeZone: must be a fixed-offset time zone without daylight saving time, e.g. 'Etc/GMT+5' or '-05:00'`
        assert.throws(() => mk({ interval: '1day', aggregateFrom: 'abc' }), (err) => err.message === afMsg)
        assert.throws(() => mk({ interval: '4hr', aggregateFrom: 5 }), (err) => err.message === afMsg)
        assert.throws(() => mk({ interval: '12hr', aggregateFrom: '8hr' }), (err) => err.message === 'invalid opt.aggregateFrom: must be an interval that divides interval and aligns with the boundaries of timeZone')
        assert.throws(() => mk({ interval: '1day', timeZone: 'America/New_York' }), (err) => err.message === dstMsg)
        assert.throws(() => mk({ interval: '4hr', timeZone: 'America/New_York' }), (err) => err.message === dstMsg)
        assert.throws(() => mk({ interval: '1day', timeZone: 'Bad/Zone' }), (err) => err.message === `invalid opt.timeZone: must be an IANA time zone name on this runtime, e.g. 'Etc/GMT-8'`)
        assert.throws(() => mk({ interval: 'zzz' }), (err) => err.message === `invalid interval: must be one of ${Object.keys(SEG_H).join(', ')}`)
        assert.throws(() => mk({ interval: 'zzz', aggregateFrom: 'auto' }), (err) => err.message.indexOf('invalid interval: must be one of') === 0)
        for (let opt of [{ interval: '4hr', timeZone: 'America/New_York', aggregateFrom: 'none' }, { interval: '3m', timeZone: 'America/New_York' }, { interval: '1hr', timeZone: 'America/New_York' }, { interval: '1day' }, { interval: '1day', aggregateFrom: null }, { interval: '1m' }, {}]) {
            assert.strictEqual(typeof mk(opt).run, 'function', JSON.stringify(opt))
        }
        assert.strictEqual(fs.existsSync(path.resolve(fdRoot, 'G17')), false)
    })

    it('G13 合併過程之 log 只在 useShowLog 時輸出', async function() {
        //規格: useShowLog 是否顯示 log
        let tz = 'Asia/Taipei'
        let dayStart = daysBack(tz, 3)
        let l1 = await quiet(async () => {
            await run('G13', 'price', '1day', { dayStart, timeZone: tz })
        })
        let l2 = await quiet(async () => {
            await run('G13', 'price', '1day', { dayStart, timeZone: tz, useShowLog: true })
        })
        assert.strictEqual(l1.filter((v) => v.indexOf('aggregate [') === 0).length, 0)
        assert.strictEqual(l2.filter((v) => v.indexOf('aggregate [') === 0).length, 1)
    })

})
