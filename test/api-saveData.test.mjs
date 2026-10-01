import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import saveData from '../src/saveData.mjs'


ot.extend(utc)
ot.extend(timezone)


//各需求述語(R01–R16)見 ./tmp/validate-plan.md, 每個 it 註明對應之述語與矩陣格

//port, 本測試專用固定埠
let port = 8091
let endpoint = `http://127.0.0.1:${port}/api/v3/klines`
let fdRoot = './test/_tmp/api-saveData'
let timeZone = 'UTC'
let ivMs = 4 * 3600 * 1000 //4h
let segMs = 8 * 24 * 3600 * 1000 //4hr之分段為8天

//dayStart, 以saveData之timeZone(UTC)計算今天往前48天, 段界為 dayStart + 8k 天, 今天恰為最新段(k=6)之起點, 舊段為 k=0..5
let todayMs = Date.parse(`${ot.tz(Date.now(), timeZone).format('YYYY-MM-DD')}T00:00:00Z`)
let dayStartMs = todayMs - 48 * 24 * 3600 * 1000
let dayStart = ot.tz(dayStartMs, timeZone).format('YYYY-MM-DD')

let fmt = (ms) => ot.tz(ms, timeZone).format('YYYY-MM-DDTHH:mm:ss')
let segStart = (k) => dayStartMs + k * segMs
let lastOpen = (k) => segStart(k) + segMs - ivMs
let closeOf = (k) => segStart(k) + segMs //段末根之名目收棒
let fd = path.resolve(fdRoot, 'T', 'price', '4hr')
let fpOf = (k) => `${fd}/${ot.tz(segStart(k), timeZone).format('YYYYMMDDHHmmss')}.csv`
let tagOf = (k) => ot.tz(segStart(k), timeZone).format('YYYYMMDDHHmmss')

//假 Binance 狀態
let reqs = [] //收到請求之 startTime
let recv = {} //startTime -> 收到請求之時刻
let mode = {
    status500: {}, //startTime -> 回 500
    html200: {}, //startTime -> 回 200 HTML
    delayMs: {}, //startTime -> 延遲回應毫秒數
    gapOpen: null, //此開盤之棒不回傳(交易所缺棒)
    anomalyOpen: null, //此開盤之棒回傳異常收棒時刻(停機)
}

//vals, 各棒之定稿值
let vals = (o) => {
    let k = Math.round(o / ivMs) % 1000
    return [`${100 + k}.1`, `${100 + k}.9`, `${100 + k}.0`, `${100 + k}.5`, '10']
}

let genBars = (startTime, endTime) => {
    let now = Date.now()
    let rs = []
    for (let o = Math.ceil(startTime / ivMs) * ivMs; o <= endTime && o <= now; o += ivMs) {
        if (o === mode.gapOpen) {
            continue
        }
        let close = o + ivMs - 1
        if (o === mode.anomalyOpen) {
            close = o + ivMs / 2
        }
        rs.push([o, ...vals(o), close, '1000', 7, '5', '500', '0'])
    }
    return rs
}

//rowFinal, 同downloadData寫出之定稿列
let rowFinal = (o) => {
    let tEnd = o === mode.anomalyOpen ? fmt(o + ivMs / 2) : fmt(o + ivMs - 1)
    return [fmt(o), ...vals(o), tEnd, '1000', 7, '5', '500'].join(', ')
}

//rowPartial, 未收棒時擷取之列, 量價與定稿不同
let rowPartial = (o, tEnd) => {
    return [fmt(o), '1.1', '1.2', '1.0', '1.15', '3', tEnd, '300', 2, '1', '100'].join(', ')
}

let csvFinal = (k, n = 48) => {
    let rows = []
    for (let i = 0; i < n; i++) {
        let o = segStart(k) + i * ivMs
        if (o === mode.gapOpen) {
            continue
        }
        rows.push(rowFinal(o))
    }
    return rows.join('\n')
}

//csvLastPartial, 前47根為定稿, 末根為未收棒值; bClamp為true時末根結束時間為擷取時刻(1.0.12後), 否則為名目收棒字串(1.0.11以前)
let csvLastPartial = (k, bClamp) => {
    let rows = []
    for (let i = 0; i < 47; i++) {
        rows.push(rowFinal(segStart(k) + i * ivMs))
    }
    let o = lastOpen(k)
    rows.push(rowPartial(o, bClamp ? fmt(o + 3600e3) : fmt(o + ivMs - 1)))
    return rows.join('\n')
}

let writeSeg = (k, c, mtimeMs) => {
    fs.writeFileSync(fpOf(k), c, 'utf8')
    fs.utimesSync(fpOf(k), new Date(), new Date(mtimeMs))
}

let readSeg = (k) => {
    return fs.readFileSync(fpOf(k), 'utf8')
}

let mtimeOf = (k) => {
    return fs.statSync(fpOf(k)).mtimeMs
}

let run = async (opt = {}) => {
    reqs = []
    let r = await saveData('T', 'price', endpoint, 'TESTUSDT', '4hr', {
        dayStart,
        timeZone,
        fdData: fdRoot,
        ...opt,
    })
    return r
}

let server = null


describe('api-saveData', function() {

    before(async function() {
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fd, { recursive: true })
        server = http.createServer((req, res) => {
            let u = new URL(req.url, `http://127.0.0.1:${port}`)
            let startTime = Number(u.searchParams.get('startTime'))
            let endTime = Number(u.searchParams.get('endTime'))
            reqs.push(startTime)
            recv[startTime] = Date.now()
            let reply = () => {
                if (mode.status500[startTime]) {
                    res.writeHead(500)
                    res.end('error')
                    return
                }
                if (mode.html200[startTime]) {
                    res.writeHead(200, { 'Content-Type': 'text/html' })
                    res.end('<html><body>challenge</body></html>')
                    return
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(genBars(startTime, endTime)))
            }
            let d = mode.delayMs[startTime] || 0
            if (d > 0) {
                setTimeout(reply, d)
            }
            else {
                reply()
            }
        })
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    })

    after(async function() {
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(fdRoot, { recursive: true, force: true })
        //test/_tmp 已無其他測試之暫存時一併移除
        let fdTmp = path.dirname(path.resolve(fdRoot))
        if (fs.existsSync(fdTmp) && fs.readdirSync(fdTmp).length === 0) {
            fs.rmdirSync(fdTmp)
        }
    })

    it('I1–I5、I9、I15 首輪先抓最新段再由新到舊抓不完整舊段, 完整與停機異常棒之舊段不抓, mtime為請求前時刻', async function() {
        //S0 不存在(矩陣1)、S1 中途中斷20筆(矩陣3)、S2 1.0.11以前未截斷之未收棒末根(矩陣7)、S3 截斷之未收棒末根(矩陣6)、S4 完整(矩陣5)、S5 停機異常棒(矩陣8)、S6 最新段(矩陣2)
        mode.anomalyOpen = lastOpen(5)
        mode.delayMs[segStart(3)] = 300
        writeSeg(1, csvFinal(1, 20), segStart(1) + 20 * ivMs - 30 * 60e3)
        writeSeg(2, csvLastPartial(2, false), lastOpen(2) + 2 * 3600e3)
        writeSeg(3, csvLastPartial(3, true), lastOpen(3) + 3600e3)
        writeSeg(4, csvFinal(4), closeOf(4) + 120e3)
        writeSeg(5, csvFinal(5), closeOf(5) + 120e3)
        let c4 = readSeg(4)
        let m4 = mtimeOf(4)
        let c5 = readSeg(5)
        let m5 = mtimeOf(5)
        let tBefore = Date.now()

        let r = await run()

        //R10: 請求順序為最新段, 其後舊段由新到舊; R02: S4、S5 不請求
        assert.deepStrictEqual(reqs, [segStart(6), segStart(3), segStart(2), segStart(1), segStart(0)])
        //R01、R05、R09: 重抓後內容為定稿值
        assert.strictEqual(readSeg(3), csvFinal(3))
        assert.strictEqual(readSeg(2), csvFinal(2))
        assert.strictEqual(readSeg(1), csvFinal(1))
        assert.strictEqual(readSeg(0), csvFinal(0))
        //R02: 完整與停機異常棒之舊段內容與mtime不變
        assert.strictEqual(readSeg(4), c4)
        assert.strictEqual(mtimeOf(4), m4)
        assert.strictEqual(readSeg(5), c5)
        assert.strictEqual(mtimeOf(5), m5)
        //R04: mtime為送出請求前之時刻, 不晚於假API收到請求之時刻(容許5毫秒之時間戳回讀誤差); 回應延遲300毫秒加downloadData之100毫秒, 若為寫檔時刻必晚於收到請求400毫秒以上
        assert.ok(mtimeOf(3) >= tBefore && mtimeOf(3) <= recv[segStart(3)] + 5, `mtime=${mtimeOf(3)} recv=${recv[segStart(3)]}`)
        //R11: items 列出下載之分段與原因; timeLast/timeKeep 取自最新段
        assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [
            [tagOf(6), 'latest'],
            [tagOf(3), 'beforeClose'],
            [tagOf(2), 'beforeClose'],
            [tagOf(1), 'count'],
            [tagOf(0), 'notExist'],
        ])
        let lastBar = Math.floor(recv[segStart(6)] / ivMs) * ivMs
        assert.strictEqual(r.timeLast, fmt(lastBar))
        assert.strictEqual(r.timeKeep, lastBar > segStart(6) ? fmt(lastBar - ivMs) : undefined)
        mode.delayMs = {}
    })

    it('I6 第二輪只抓最新段(收斂)', async function() {
        //R03
        await run()
        assert.deepStrictEqual(reqs, [segStart(6)])
    })

    it('I1b 擷取時刻晚於名目收棒但未過寬限之舊段仍重抓', async function() {
        //R01、矩陣20: 名目收棒後伺服器仍可能回非定稿值
        writeSeg(3, csvLastPartial(3, false), closeOf(3) + 10e3)
        await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(3)])
        assert.strictEqual(readSeg(3), csvFinal(3))
    })

    it('I7 重抓時API回500則保留舊檔, 下輪再試', async function() {
        //R09、矩陣22
        let c = csvLastPartial(3, true)
        writeSeg(3, c, lastOpen(3) + 3600e3)
        mode.status500[segStart(3)] = true
        await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(3)])
        assert.strictEqual(readSeg(3), c)
        mode.status500 = {}
        await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(3)])
        assert.strictEqual(readSeg(3), csvFinal(3))
    })

    it('I7b HTTP 200 但回應非陣列(HTML)時不覆寫既有檔', async function() {
        //R12、矩陣23
        let c = csvLastPartial(2, true)
        writeSeg(2, c, lastOpen(2) + 3600e3)
        mode.html200[segStart(2)] = true
        await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(2)])
        assert.strictEqual(readSeg(2), c)
        mode.html200 = {}
        await run()
        assert.strictEqual(readSeg(2), csvFinal(2))
    })

    it('I8 交易所段中缺棒之舊段照舊每輪重抓(O1暫緩, 行為不變)', async function() {
        //R09、矩陣24
        mode.gapOpen = segStart(4) + 10 * ivMs
        writeSeg(4, csvFinal(4), closeOf(4) + 120e3)
        await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(4)])
        assert.strictEqual(readSeg(4).split('\n').length, 47)
        await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(4)])
        mode.gapOpen = null
        await run()
        assert.strictEqual(readSeg(4), csvFinal(4))
        await run()
        assert.deepStrictEqual(reqs, [segStart(6)])
    })

    it('I9b timeBudget逾時時只抓最新段, 舊段留待下次呼叫', async function() {
        //R10、矩陣28
        let c = csvLastPartial(3, true)
        writeSeg(3, c, lastOpen(3) + 3600e3)
        fs.rmSync(fpOf(0))
        await run({ timeBudget: 1 })
        assert.deepStrictEqual(reqs, [segStart(6)])
        assert.strictEqual(readSeg(3), c)
        assert.strictEqual(fs.existsSync(fpOf(0)), false)
        await run({ timeBudget: 0 })
        assert.deepStrictEqual(reqs, [segStart(6), segStart(3), segStart(0)])
    })

    it('I10 最新段下載失敗時timeLast與timeKeep為undefined, 不指向舊段', async function() {
        //R11、矩陣29
        writeSeg(3, csvLastPartial(3, true), lastOpen(3) + 3600e3)
        mode.status500[segStart(6)] = true
        let r = await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(3)])
        assert.strictEqual(r.timeLast, undefined)
        assert.strictEqual(r.timeKeep, undefined)
        assert.strictEqual(readSeg(3), csvFinal(3))
        mode.status500 = {}
    })

    it('I11 useConvertToCsv為false時仍存CSV', async function() {
        //R16、矩陣30
        fs.rmSync(fpOf(0))
        await run({ useConvertToCsv: false })
        assert.strictEqual(readSeg(0), csvFinal(0))
    })

    it('I12 useDryRun時不發請求不寫檔, items列出將下載之分段與原因', async function() {
        //R15、矩陣31
        let c = csvLastPartial(3, true)
        writeSeg(3, c, lastOpen(3) + 3600e3)
        fs.rmSync(fpOf(0))
        let r = await run({ useDryRun: true })
        assert.deepStrictEqual(reqs, [])
        assert.deepStrictEqual(r.items.map((v) => [v.tag, v.reason]), [
            [tagOf(6), 'latest'],
            [tagOf(3), 'beforeClose'],
            [tagOf(0), 'notExist'],
        ])
        assert.strictEqual(r.timeLast, undefined)
        assert.strictEqual(readSeg(3), c)
        assert.strictEqual(fs.existsSync(fpOf(0)), false)
        await run()
    })

    it('I13 單一分段寫檔失敗時不中斷其他分段', async function() {
        //R13、矩陣32: 以同名資料夾佔住S3之檔案路徑, 令寫檔失敗
        fs.rmSync(fpOf(3))
        fs.mkdirSync(fpOf(3))
        writeSeg(1, csvLastPartial(1, true), lastOpen(1) + 3600e3)
        await run()
        assert.deepStrictEqual(reqs, [segStart(6), segStart(3), segStart(1)])
        assert.strictEqual(readSeg(1), csvFinal(1))
        fs.rmSync(fpOf(3), { recursive: true })
        await run()
        assert.strictEqual(readSeg(3), csvFinal(3))
    })

    it('I14 not complete訊息僅在useShowLog時輸出', async function() {
        //R14、矩陣33
        let logs = []
        let log = console.log
        console.log = (...args) => {
            logs.push(args.join(' '))
        }
        try {
            writeSeg(3, csvLastPartial(3, true), lastOpen(3) + 3600e3)
            await run({ useShowLog: false })
            let n1 = logs.filter((v) => v.indexOf('not complete') >= 0).length
            writeSeg(3, csvLastPartial(3, true), lastOpen(3) + 3600e3)
            await run({ useShowLog: true })
            let n2 = logs.filter((v) => v.indexOf('not complete: beforeClose') >= 0).length
            console.log = log
            assert.strictEqual(n1, 0)
            assert.strictEqual(n2, 1)
        }
        finally {
            console.log = log
        }
    })

})
