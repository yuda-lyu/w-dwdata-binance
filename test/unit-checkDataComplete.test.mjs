import assert from 'assert'
import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import checkDataComplete from '../src/checkDataComplete.mjs'


ot.extend(utc)
ot.extend(timezone)


//各需求述語(R01–R08)見 ./tmp/validate-plan.md, 每個 it 註明對應之述語

let fmt = (ms, tz) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')

//mkCsv, 產生分段檔內容, 欄位同downloadData輸出: 開始時間, 開高低收, 量, 結束時間, 成交金額, 筆數, 主動買入量, 主動買入金額
let mkCsv = ({ startMs, n, dataSec, tz = 'Asia/Taipei', lastEnd = null, index = false, eol = '\n' }) => {
    let rows = []
    for (let i = 0; i < n; i++) {
        let o = startMs + i * dataSec * 1000
        let tEnd = fmt(o + dataSec * 1000 - 1, tz)
        if (i === n - 1 && lastEnd !== null) {
            tEnd = lastEnd
        }
        if (index) {
            rows.push(`${fmt(o, tz)}, -0.00043777, 0.00042008, -0.00098395, -0.00053575, 0, ${tEnd}, 0, 720, 0, 0`)
        }
        else {
            rows.push(`${fmt(o, tz)}, 100.1, 100.9, 100.0, 100.5, 10, ${tEnd}, 1000, 7, 5, 500`)
        }
    }
    return rows.join(eol)
}

//4hr分段: 台北 2026-09-22T00:00:00 起 48 根, 末根開盤 2026-09-29T20:00:00, 名目收棒 2026-09-30T00:00:00(台北)
let start4h = Date.parse('2026-09-22T00:00:00+08:00')
let lastOpen4h = start4h + 47 * 4 * 3600e3
let close4h = lastOpen4h + 4 * 3600e3
let grace = 60 * 1000
let opt4h = { dataNum: 48, dataSec: 14400 }


describe('unit-checkDataComplete', function() {

    it('U1 筆數不足時判不完整(count)', function() {
        //R09: 筆數不足重抓
        let c = mkCsv({ startMs: start4h, n: 20, dataSec: 14400 })
        let r = checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace })
        assert.deepStrictEqual(r, { complete: false, reason: 'count' })
    })

    it('U2 筆數超過時判不完整(count)', function() {
        //R09: 筆數不符重抓
        let c = mkCsv({ startMs: start4h, n: 49, dataSec: 14400 })
        let r = checkDataComplete(c, { ...opt4h, mtimeMs: close4h + 4 * 3600e3 + grace })
        assert.deepStrictEqual(r, { complete: false, reason: 'count' })
    })

    it('U3 筆數滿且擷取時刻不早於名目收棒加寬限時判完整', function() {
        //R02: 收棒後寬限外擷取者不重抓
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        let r = checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace + 1000 })
        assert.deepStrictEqual(r, { complete: true, reason: '' })
    })

    it('U4a 末根被截斷且擷取時刻早於名目收棒時判不完整(beforeClose)', function() {
        //R01: 段末根於收棒前擷取者須補抓
        let tCap = lastOpen4h + 3600e3
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400, lastEnd: fmt(tCap, 'Asia/Taipei') })
        let r = checkDataComplete(c, { ...opt4h, mtimeMs: tCap })
        assert.deepStrictEqual(r, { complete: false, reason: 'beforeClose' })
    })

    it('U4b 擷取時刻晚於名目收棒但未過寬限時判不完整(beforeClose)', function() {
        //R01、矩陣第20格: 幣安於名目收棒後仍可能短暫回傳非定稿值
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        let r = checkDataComplete(c, { ...opt4h, mtimeMs: close4h + 1000 })
        assert.deepStrictEqual(r, { complete: false, reason: 'beforeClose' })
    })

    it('U4c 擷取時刻恰為名目收棒加寬限時判完整', function() {
        //R02: 邊界, 不早於收棒加寬限即視為定稿
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace - 1 }), { complete: false, reason: 'beforeClose' })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace }), { complete: true, reason: '' })
    })

    it('U4d 寬限可由timeGrace設定, 未給或無效時為60000', function() {
        //R01: 寬限可設定
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h, timeGrace: 0 }), { complete: true, reason: '' })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + 4999, timeGrace: 5000 }), { complete: false, reason: 'beforeClose' })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + 5000, timeGrace: 5000 }), { complete: true, reason: '' })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + 59999, timeGrace: -1 }), { complete: false, reason: 'beforeClose' })
    })

    it('U5 1.0.11以前寫入之未截斷末列, 擷取時刻早於收棒時判不完整(beforeClose)', function() {
        //R05: 末列結束時間為名目收棒字串, 但檔案修改時間早於收棒
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        let r = checkDataComplete(c, { ...opt4h, mtimeMs: lastOpen4h + 2 * 3600e3 })
        assert.deepStrictEqual(r, { complete: false, reason: 'beforeClose' })
    })

    it('U6 停機異常棒(末列結束時間早於名目收棒)於寬限後擷取時判完整, 不得誤判', function() {
        //R02: 以幣安實際資料之形狀, 1m 2021-12-24T12:59:00(台北)收棒於 12:59:56.158
        let start1m = Date.parse('2021-12-24T12:00:00+08:00')
        let c = mkCsv({ startMs: start1m, n: 60, dataSec: 60, lastEnd: '2021-12-24T12:59:56' })
        let close1m = Date.parse('2021-12-24T13:00:00+08:00')
        let r = checkDataComplete(c, { dataNum: 60, dataSec: 60, mtimeMs: close1m + grace })
        assert.deepStrictEqual(r, { complete: true, reason: '' })
    })

    it('U7 檔案修改時間因時鐘錯誤而早於收棒時判不完整, 重抓後以寬限外時刻判完整(收斂)', function() {
        //R01、R03: 矩陣第10格, 刻意允許多抓一次
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: start4h }), { complete: false, reason: 'beforeClose' })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace }), { complete: true, reason: '' })
    })

    it('U8 非整點時區之段末根跨段界時, 以末根名目收棒判斷而非段界', function() {
        //R06: Asia/Kolkata(+5:30)之段界為 18:30Z, 4h棒以 UTC 對齊, 段末根 16:00Z 開盤、20:00Z 名目收棒
        let tz = 'Asia/Kolkata'
        let segEnd = Date.parse('2026-09-30T18:30:00Z')
        let firstOpen = Date.parse('2026-09-22T20:00:00Z')
        let c = mkCsv({ startMs: firstOpen, n: 48, dataSec: 14400, tz })
        let closeIst = Date.parse('2026-09-30T20:00:00Z')
        let o = { dataNum: 48, dataSec: 14400, timeZone: tz }
        assert.deepStrictEqual(checkDataComplete(c, { ...o, mtimeMs: segEnd + 10 * 60e3 }), { complete: false, reason: 'beforeClose' })
        assert.deepStrictEqual(checkDataComplete(c, { ...o, mtimeMs: closeIst + grace }), { complete: true, reason: '' })
    })

    it('U9 六種 interval 之名目收棒皆為末列開盤加每筆時長', function() {
        //R08: dataSec 60/300/900/1800/3600/14400
        let ks = [
            { dataSec: 60, dataNum: 60 },
            { dataSec: 300, dataNum: 48 },
            { dataSec: 900, dataNum: 48 },
            { dataSec: 1800, dataNum: 48 },
            { dataSec: 3600, dataNum: 48 },
            { dataSec: 14400, dataNum: 48 },
        ]
        let startMs = Date.parse('2026-09-22T00:00:00+08:00')
        for (let k of ks) {
            let c = mkCsv({ startMs, n: k.dataNum, dataSec: k.dataSec })
            let close = startMs + k.dataNum * k.dataSec * 1000
            assert.deepStrictEqual(checkDataComplete(c, { ...k, mtimeMs: close + grace - 1 }), { complete: false, reason: 'beforeClose' }, `dataSec=${k.dataSec}`)
            assert.deepStrictEqual(checkDataComplete(c, { ...k, mtimeMs: close + grace }), { complete: true, reason: '' }, `dataSec=${k.dataSec}`)
        }
    })

    it('U10 溢價指數格式(量欄為0)之判定同現貨', function() {
        //R01、R02: 欄位位置相同
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400, index: true })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h - 1000 }), { complete: false, reason: 'beforeClose' })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace }), { complete: true, reason: '' })
    })

    it('U11 末列殘缺時判不完整(invalidRow)', function() {
        //R07: 寫檔中斷之各種形狀
        let base = mkCsv({ startMs: start4h, n: 47, dataSec: 14400 })
        let cs = [
            `${base}\n2026-09-29T2`,
            `${base}\n2026-09-29T20:00:00, 100.1, 100.9`,
            `${base}\n2026-09-29T20:00:00, 100.1, 100.9, 100.0, 100.5, 10, 2026-09-2`,
            `${base}\n2026-09-29T20:00:00, 100.1, 100.9, 100.0, 100.5, 10, abc, 1000, 7, 5, 500`,
        ]
        for (let c of cs) {
            assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace }), { complete: false, reason: 'invalidRow' })
        }
    })

    it('U11b 列中有空欄時欄位不位移、判定正確', function() {
        //R07: 以split切割保留空欄位置
        let base = mkCsv({ startMs: start4h, n: 47, dataSec: 14400 })
        let c = `${base}\n2026-09-29T20:00:00, 100.1, 100.9, 100.0, 100.5, , 2026-09-29T23:59:59, , 7, , `
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace }), { complete: true, reason: '' })
    })

    it('U12 CRLF換行與檔尾換行不影響筆數與末列解析', function() {
        //R07: 既有sep切列會剔除空列與空白
        let c = `${mkCsv({ startMs: start4h, n: 48, dataSec: 14400, eol: '\r\n' })}\r\n`
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace }), { complete: true, reason: '' })
        assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h }), { complete: false, reason: 'beforeClose' })
    })

    it('U13 無內容時判不完整(empty)', function() {
        //R09: 空檔重抓
        for (let c of ['', '\n', '  \n  ']) {
            assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs: close4h + grace }), { complete: false, reason: 'empty' })
        }
    })

    it('U14 未給檔案修改時間時判不完整(noMtime)', function() {
        //R01: 無法確認是否已收棒, 不得回報完整
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        for (let mtimeMs of [undefined, null, 'abc']) {
            assert.deepStrictEqual(checkDataComplete(c, { ...opt4h, mtimeMs }), { complete: false, reason: 'noMtime' })
        }
    })

    it('U15 dataNum或dataSec無效時拋錯', function() {
        //參數錯誤屬呼叫端程式錯誤
        let c = mkCsv({ startMs: start4h, n: 48, dataSec: 14400 })
        assert.throws(() => checkDataComplete(c, { dataSec: 14400, mtimeMs: close4h + grace }), /invalid opt.dataNum/)
        assert.throws(() => checkDataComplete(c, { dataNum: 48, mtimeMs: close4h + grace }), /invalid opt.dataSec/)
    })

})
