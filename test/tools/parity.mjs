//對拍工具: 比對「基準版」與「現行版」之 saveData 與 downloadData 於未給新選項、請求皆成功且交易所無缺根時之外部可觀察行為是否逐位相同:
//請求序列(查詢字串與全部標頭)、輸出樹(檔名、內容、修改時間)、console 輸出、回傳值(含鍵序)。
//用法: node test/tools/parity.mjs --base <基準版之 src 資料夾> [--new ./src] [--quick] [--detail] [--mutate file|header|query|log|mtime|clock|return]
//  --base 基準版之 src(例: 以 git archive 解出之發布版); --new 受測版之 src(預設 ./src); --quick 縮小矩陣;
//  --mutate 只動受測版之一項(多寫一檔、多一個標頭、多一個查詢參數、多印一行、修改時間多1毫秒、多取一次現在、回傳多一鍵), 驗證本工具抓得到差異(應回報有差異, 離開碼 1)。
//每案以兩種時鐘各跑一輪: 固定之假時鐘, 與前進式假時鐘(每讀一次「現在」前進1毫秒, 令多取一次現在之差異顯現於修改時間)。
//全程只連本機假交易所(listen(0))與假時鐘, 不連真實交易所。暫存於 ./tmp/parity/(結束時清除)。
import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { pathToFileURL } from 'url'
import axios from 'axios'


let args = process.argv.slice(2)
let argOf = (k, def) => {
    let i = args.indexOf(k)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def
}
let baseSrc = path.resolve(argOf('--base', ''))
let newSrc = path.resolve(argOf('--new', './src'))
let quick = args.indexOf('--quick') >= 0
let detail = args.indexOf('--detail') >= 0 //列出前幾個差異之首個不同項
let showLogAll = args.indexOf('--log') >= 0 //全部案皆開 useShowLog(預設隔案交替)
let mutate = argOf('--mutate', '')
if (!fs.existsSync(path.join(baseSrc, 'saveData.mjs')) || !fs.existsSync(path.join(newSrc, 'saveData.mjs'))) {
    console.error('usage: node test/tools/parity.mjs --base <src> [--new ./src] [--quick] [--mutate <名稱>]')
    process.exit(2)
}

let H = 3600e3
let D = 24 * H
let root = path.resolve('./tmp/parity')


//假時鐘: 取代全域 Date(無參數之 new Date() 與 Date.now() 取注入之時刻; step 非 0 時每讀一次前進 step 毫秒)
let RealDate = globalThis.Date
let clock = { now: 0, step: 0 }
let readNow = () => {
    let v = clock.now
    clock.now += clock.step
    return v
}
class FakeDate extends RealDate {
    constructor(...a) {
        if (a.length === 0) {
            super(readNow())
        }
        else {
            super(...a)
        }
    }

    static now() {
        return readNow()
    }
}


//假交易所: 各根依開盤毫秒導出(逐根相異); 不缺根(自 1970 起每一格皆有, 含仍在形成之根); 每次請求至多 limit 根
let EX = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': H, '2h': 2 * H, '4h': 4 * H, '6h': 6 * H, '8h': 8 * H, '12h': 12 * H, '1d': D, '1w': 7 * D }
let reqLog = []
let server = http.createServer((req, res) => {
    reqLog.push({ url: req.url, headers: req.headers })
    let u = new URL(req.url, 'http://127.0.0.1')
    let step = EX[u.searchParams.get('interval')]
    let s = Number(u.searchParams.get('startTime'))
    let e = Number(u.searchParams.get('endTime'))
    let limit = Number(u.searchParams.get('limit'))
    let anchor = u.searchParams.get('interval') === '1w' ? 4 * D : 0
    let nowMs = clock.now //不經 readNow, 免得伺服器端之讀取影響前進式時鐘
    let rs = []
    if (step) {
        for (let o = Math.ceil((s - anchor) / step) * step + anchor; o <= e && o <= nowMs && rs.length < limit; o += step) {
            let k = Math.round(o / 60000) % 99991
            rs.push([o, `${k}.1`, `${k}.7`, `${k}.0`, `${k}.3`, `${k}.05`, o + step - 1, `${k}.2`, k % 977 + 7, `${k}.01`, `${k}.02`, '0'])
        }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(rs))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let port = server.address().port
let endpoint = `http://127.0.0.1:${port}/api/v3/klines`

//wsemi 之 delay(100)(2xx 後之頻率節制)改為立即(兩版相同, 只為縮短對拍時間)
let setTimeoutReal = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...a) => setTimeoutReal(fn, ms === 100 ? 0 : ms, ...a)

//console 擷取(不輸出)
let logs = []
let consoleReal = { log: console.log, warn: console.warn, error: console.error }
let capture = () => {
    for (let k of ['log', 'warn', 'error']) {
        console[k] = (...a) => {
            logs.push(`${k}: ${a.map((v) => (v instanceof Error ? `${v.name}: ${v.message}` : typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`)
        }
    }
}
let uncapture = () => {
    Object.assign(console, consoleReal)
}


let load = async (src) => {
    let m = {}
    for (let n of ['saveData', 'downloadData']) {
        m[n] = (await import(pathToFileURL(path.join(src, `${n}.mjs`)).href)).default
    }
    return m
}
let sides = [
    { name: 'base', mod: await load(baseSrc) },
    { name: 'new', mod: await load(newSrc) },
]

let sha = (s) => crypto.createHash('sha1').update(s).digest('hex')

//listFiles, 資料夾樹內之檔案(絕對路徑, 排序)
let listFiles = (fd) => {
    let rs = []
    let walk = (d) => {
        if (!fs.existsSync(d)) {
            return
        }
        for (let n of fs.readdirSync(d).sort()) {
            let p = path.join(d, n)
            if (fs.statSync(p).isDirectory()) {
                walk(p)
            }
            else {
                rs.push(p)
            }
        }
    }
    walk(fd)
    return rs
}

//snapshot, 資料夾樹之檔名、大小、內容雜湊、修改時間(不含資料夾本身)
let snapshot = (fd) => listFiles(fd).map((p) => {
    let st = fs.statSync(p)
    return `${path.relative(fd, p).split(path.sep).join('/')} ${st.size} ${sha(fs.readFileSync(p))} ${st.mtimeMs}`
})

//norm, 回傳值轉為字串(含鍵序), 絕對路徑換為 <ROOT>
let norm = (v, fd) => JSON.stringify(v, (k, x) => (typeof x === 'string' ? x.split(fd).join('<ROOT>').split(fd.replace(/\\/g, '/')).join('<ROOT>') : x))

//變異: 只套用於受測版(驗證本工具抓得到差異)
let interceptorIds = []
let beforeNew = () => {
    if (mutate === 'header') {
        interceptorIds.push(axios.interceptors.request.use((c) => {
            c.headers['X-Extra'] = '1'
            return c
        }))
    }
    if (mutate === 'query') {
        interceptorIds.push(axios.interceptors.request.use((c) => {
            c.params = { ...c.params, extra: 1 }
            return c
        }))
    }
    if (mutate === 'clock') {
        interceptorIds.push(axios.interceptors.request.use((c) => {
            Date.now() //多取一次現在
            return c
        }))
    }
    if (mutate === 'log') {
        console.log('extra line')
    }
}
let afterNew = (fd, result) => {
    for (let id of interceptorIds) {
        axios.interceptors.request.eject(id)
    }
    interceptorIds = []
    if (mutate === 'file') {
        fs.mkdirSync(fd, { recursive: true })
        fs.writeFileSync(path.join(fd, 'extra.txt'), 'x', 'utf8')
    }
    if (mutate === 'mtime') {
        let fs0 = listFiles(fd)
        if (fs0.length > 0) {
            let t = fs.statSync(fs0[0]).mtimeMs
            fs.utimesSync(fs0[0], new RealDate(), new RealDate(t + 1))
        }
    }
    if (mutate === 'return' && result && typeof result === 'object') {
        result.extra = 1
    }
}


//案: 週期鍵 × 時區 × 取得方式; dayStart 依週期取使分段數少者
let TZS = quick ? ['UTC', 'Asia/Taipei', 'Asia/Kathmandu'] : ['UTC', 'Asia/Taipei', 'Asia/Kolkata', 'Asia/Kathmandu', 'America/St_Johns', 'Pacific/Chatham', 'Etc/GMT+12']
let IVS = quick ? ['5m', '4hr', '1day'] : ['1m', '3m', '5m', '15m', '30m', '1hr', '2hr', '4hr', '6hr', '8hr', '12hr', '1day', '1week']
let SPAN = { '1m': 0.5, '3m': 1, '5m': 1, '15m': 2, '30m': 3, '1hr': 6, '2hr': 10, '4hr': 20, '6hr': 30, '8hr': 40, '12hr': 60, '1day': 100, '1week': 400 }
let MODES = quick ? ['auto'] : ['auto', 'none']
let T0 = RealDate.parse('2026-06-17T09:17:23.456Z')

let only = argOf('--only', '') //只跑案名含此字串者(除錯用)
let cases = []
for (let iv of IVS) {
    for (let tz of TZS) {
        for (let af of MODES) {
            if (`${iv}_${tz.replace(/\W/g, '-')}_${af}`.indexOf(only) >= 0) {
                cases.push({ iv, tz, af })
            }
        }
    }
}

let diffs = []
let nStep = 0
let nReq = 0
let nFile = 0
let nLog = 0

let compare = (cid, step, a, b) => {
    nStep++
    nReq += a.reqs.length
    nFile += a.tree.length
    nLog += a.logs.length
    let chk = (what, x, y) => {
        if (x !== y) {
            diffs.push(`${cid} ${step} ${what}`)
            if (detail && diffs.length <= 3) {
                let xs = JSON.parse(x === undefined ? 'null' : x)
                let ys = JSON.parse(y === undefined ? 'null' : y)
                if (Array.isArray(xs) && Array.isArray(ys)) {
                    let i = 0
                    while (i < xs.length && i < ys.length && JSON.stringify(xs[i]) === JSON.stringify(ys[i])) {
                        i++
                    }
                    diffs.push(`    首個差異於第 ${i} 項(共 ${xs.length} 對 ${ys.length}): 基準=${JSON.stringify(xs[i])} 受測=${JSON.stringify(ys[i])}`)
                }
            }
        }
    }
    chk('requests(查詢字串與標頭)', JSON.stringify(a.reqs), JSON.stringify(b.reqs))
    chk('tree(檔名、內容、修改時間)', JSON.stringify(a.tree), JSON.stringify(b.tree))
    chk('console', JSON.stringify(a.logs), JSON.stringify(b.logs))
    chk('result', a.result, b.result)
}

//runBoth, 於同一假時鐘之某時刻以兩版各跑一次(基準版先), 比對兩版之觀察
let runBoth = async (cid, step, nowMs, cidDir, f) => {
    let out = []
    for (let s of sides) {
        reqLog = []
        logs = []
        clock.now = nowMs
        capture()
        if (s.name === 'new') {
            beforeNew()
        }
        let result = null
        try {
            result = await f(s)
        }
        catch (err) {
            result = { threw: String(err && err.message) }
        }
        uncapture()
        let fd = path.join(root, cidDir, s.name)
        if (s.name === 'new') {
            afterNew(fd, result)
        }
        //console 與回傳中之絕對路徑(含各版自己之資料夾)換為 <ROOT>
        let fdRoot = path.join(root, cidDir, s.name)
        let rep = (v) => v.split(fdRoot).join('<ROOT>').split(fdRoot.replace(/\\/g, '/')).join('<ROOT>')
        out.push({ reqs: reqLog.map((r) => ({ url: r.url, headers: r.headers })), logs: logs.map(rep), tree: snapshot(fd), result: norm(result, fd) })
    }
    compare(cid, step, out[0], out[1])
}

let t00 = performance.now()
fs.rmSync(root, { recursive: true, force: true })
globalThis.Date = FakeDate
let idx = 0
for (let c of cases) {
    idx++
    let cid = `${c.iv}_${c.tz.replace(/\W/g, '-')}_${c.af}`
    let dayStart = new RealDate(T0 - SPAN[c.iv] * D).toISOString().slice(0, 10)
    for (let adv of [false, true]) {
        clock.step = adv ? 1 : 0
        let cidDir = `${cid}${adv ? '_adv' : ''}`
        let optOf = (s, extra = {}) => ({ dayStart, timeZone: c.tz, aggregateFrom: c.af, fdData: path.join(root, cidDir, s.name), useShowLog: showLogAll || idx % 2 === 0, ...extra })
        let call = (s, extra) => s.mod.saveData('BTC', 'price', endpoint, 'BTCUSDT', c.iv, optOf(s, extra))
        let n = 0
        await runBoth(cidDir, `s${n++}-首次`, T0, cidDir, (s) => call(s))
        await runBoth(cidDir, `s${n++}-十分鐘後`, T0 + 10 * 60000, cidDir, (s) => call(s))
        await runBoth(cidDir, `s${n++}-乾跑`, T0 + 11 * 60000, cidDir, (s) => call(s, { useDryRun: true }))
        //竄改: 刪最舊之分段檔、將次舊者改為無效內容
        await runBoth(cidDir, `s${n++}-竄改後`, T0 + 12 * 60000, cidDir, async (s) => {
            let files = listFiles(path.join(root, cidDir, s.name)).filter((p) => p.endsWith('.csv'))
            if (files.length > 1) {
                fs.rmSync(files[0])
                fs.writeFileSync(files[1], 'garbage', 'utf8')
            }
            return call(s)
        })
        //前進(小週期 1 天、1hr 與 2hr 6 天、其餘 30 天, 免得分段數過多): 含 timeBudget(預算極小, 舊分段留待下次)與其後再跑
        let later = ['1m', '3m', '5m', '15m', '30m'].indexOf(c.iv) >= 0 ? D : ['1hr', '2hr'].indexOf(c.iv) >= 0 ? 6 * D : 30 * D
        await runBoth(cidDir, `s${n++}-前進後timeBudget`, T0 + later, cidDir, (s) => call(s, { timeBudget: 1 }))
        await runBoth(cidDir, `s${n++}-前進後再跑`, T0 + later + 5 * 60000, cidDir, (s) => call(s))
    }
    //公開之 downloadData: 回傳 CSV 與 useConvertToCsv 為 false 之陣列
    clock.step = 0
    await runBoth(`${cid}_dl`, 'download', T0, `${cid}_dl`, async (s) => {
        let a = await s.mod.downloadData(endpoint, 'BTCUSDT', '2026-06-16T00:00:00', '2026-06-16T23:59:59', '1h', { timeZone: c.tz })
        let b = await s.mod.downloadData(endpoint, 'BTCUSDT', '2026-06-16T00:00:00', '2026-06-16T03:59:59', '1h', { timeZone: c.tz, useConvertToCsv: false })
        return { a, b }
    })
}
globalThis.Date = RealDate
globalThis.setTimeout = setTimeoutReal
await new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
})
fs.rmSync(root, { recursive: true, force: true })
try {
    let d = path.resolve('./tmp')
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) {
        fs.rmdirSync(d)
    }
}
catch (err) {
    //忽略
}

let sec = Math.round((performance.now() - t00) / 1000)
console.log(`parity: 案 ${cases.length}(各含固定時鐘與前進式時鐘兩輪與 downloadData), 比對 ${nStep} 步, 請求 ${nReq} 次、檔 ${nFile} 個、console ${nLog} 列(皆以基準版計); 差異 ${diffs.length} 處; ${sec}s${mutate ? `; 變異: ${mutate}` : ''}`)
for (let d of diffs.slice(0, 20)) {
    console.log('  DIFF', d)
}
process.exit(diffs.length === 0 ? 0 : 1)
