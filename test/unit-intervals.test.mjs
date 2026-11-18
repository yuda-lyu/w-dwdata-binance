import assert from 'assert'
import { getIntervals, getOffsets, getIntervalPlan } from '../src/intervals.mjs'
import WDwdataBinace from '../src/WDwdataBinace.mjs'


//規格出處: intervals.mjs 之 getIntervals、getOffsets、getIntervalPlan 之 JSDoc 與 README〈Intervals and day boundary〉(Gitea #183)
//各 it 之註解標明對應之規格句

//plan, 合併時之預期; dayStart 未給時為 2020-01-01
let agg = (interval, tz, base, count, dataSec, utcOffset, ds = '20200101') => ({
    interval,
    mode: 'aggregate',
    key: `${interval}_tz${tz}_d${ds}_from${base}`,
    base,
    baseKey: `${base}_tz${tz}_d${ds}`,
    count,
    dataSec,
    utcOffset,
})
let nat = (interval, dataSec, utcOffset) => ({ interval, mode: 'native', key: interval, base: interval, baseKey: interval, count: 1, dataSec, utcOffset })

let KEYS = ['1m', '3m', '5m', '15m', '30m', '1hr', '2hr', '4hr', '6hr', '8hr', '12hr', '1day', '1week']
let LEGACY6 = ['1m', '5m', '15m', '30m', '1hr', '4hr']
let MSG_INTERVAL = `invalid interval: must be one of ${KEYS.join(', ')}`
let MSG_AF = `invalid opt.aggregateFrom: must be one of auto, none, ${KEYS.join(', ')}`
let MSG_AF_ALIGN = 'invalid opt.aggregateFrom: must be an interval that divides interval and aligns with the boundaries of timeZone'
let MSG_DST = `invalid opt.timeZone: must be a fixed-offset time zone without daylight saving time, e.g. 'Etc/GMT+5' or '-05:00'`
let MSG_SMALL = 'invalid opt.timeZone: must be zero or a UTC offset of at least 30 minutes'
let MSG_IANA = `invalid opt.timeZone: must be an IANA time zone name on this runtime, e.g. 'Etc/GMT-8'`
let MSG_WHOLE = 'invalid opt.timeZone: must be a time zone whose UTC offset is in whole minutes'

let supportsOffsetTz = () => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: '+08:00' })
        return true
    }
    catch (err) {
        return false
    }
}


describe('unit-intervals', function() {

    it('I1 週期表: 13 個週期鍵, 每鍵每段時數*3600 = 每段筆數*每根秒數, 每次回傳新物件', function() {
        //規格: hourInterval*3600=dataNum*dataSec; 每次回傳新物件
        let kp = getIntervals()
        assert.deepStrictEqual(Object.keys(kp), KEYS)
        for (let k of Object.keys(kp)) {
            assert.strictEqual(kp[k].hourInterval * 3600, kp[k].dataNum * kp[k].dataSec, k)
        }
        kp['1day'].dataSec = 1
        assert.strictEqual(getIntervals()['1day'].dataSec, 86400)
    })

    it('I2 aggregateFrom 未給(undefined、null)一律為 auto, 不分週期鍵: 既有六鍵於台北與 UTC 為直接下載', function() {
        //規格: aggregateFrom 未給時一律為 'auto'(不分週期鍵); 原生格線與 timeZone 之界線對齊者直接下載(台北之 1m、5m、15m、30m、1hr、4hr、UTC 之各鍵)
        let kp = getIntervals()
        for (let k of LEGACY6) {
            for (let [tz, off] of [['Asia/Taipei', 480], ['UTC', 0]]) {
                let exp = nat(k, kp[k].dataSec, off)
                assert.deepStrictEqual(getIntervalPlan(k, { timeZone: tz }), exp, `${k} ${tz}`)
                assert.deepStrictEqual(getIntervalPlan(k, { timeZone: tz, aggregateFrom: undefined }), exp, `${k} ${tz} undefined`)
                assert.deepStrictEqual(getIntervalPlan(k, { timeZone: tz, aggregateFrom: null }), exp, `${k} ${tz} null`)
                assert.deepStrictEqual(getIntervalPlan(k, { timeZone: tz, aggregateFrom: 'auto' }), exp, `${k} ${tz} auto`)
            }
            assert.deepStrictEqual(getIntervalPlan(k), getIntervalPlan(k, { timeZone: 'Asia/Taipei', dayStart: '2020-01-01' }), `${k} 預設為台北、2020-01-01`)
        }
        //未給與 auto 對新增之週期鍵亦同(不依鍵而異)
        for (let k of KEYS) {
            for (let tz of ['Asia/Taipei', 'UTC', 'Asia/Tokyo', 'Asia/Kolkata']) {
                assert.deepStrictEqual(getIntervalPlan(k, { timeZone: tz }), getIntervalPlan(k, { timeZone: tz, aggregateFrom: 'auto' }), `${k} ${tz}`)
                assert.deepStrictEqual(getIntervalPlan(k, { timeZone: tz }), getIntervalPlan(k, { timeZone: tz, aggregateFrom: null }), `${k} ${tz} null`)
            }
        }
    })

    it('I2b 既有六鍵於目標未對齊之時區改為合併; none 仍為原生格線', function() {
        //規格: 未給 aggregateFrom 時('auto')目標之原生格線與 timeZone 之界線不對齊者改為合併(UTC+5:30 之 1hr、UTC+9 之 4hr); 明給 'none' 為原生格線
        assert.deepStrictEqual(getIntervalPlan('1hr', { timeZone: 'Asia/Kolkata' }), agg('1hr', '+0530', '30m', 2, 3600, 330))
        assert.deepStrictEqual(getIntervalPlan('4hr', { timeZone: 'Asia/Tokyo' }), agg('4hr', '+0900', '1hr', 4, 14400, 540))
        assert.deepStrictEqual(getIntervalPlan('4hr', { timeZone: 'Asia/Kolkata' }), agg('4hr', '+0530', '30m', 8, 14400, 330))
        assert.deepStrictEqual(getIntervalPlan('30m', { timeZone: 'Asia/Kathmandu' }), agg('30m', '+0545', '15m', 2, 1800, 345))
        assert.deepStrictEqual(getIntervalPlan('1hr', { timeZone: 'Asia/Kathmandu' }), agg('1hr', '+0545', '15m', 4, 3600, 345))
        for (let [k, tz] of [['1hr', 'Asia/Kolkata'], ['4hr', 'Asia/Tokyo'], ['1hr', 'Asia/Taipei'], ['1day', 'Asia/Taipei']]) {
            assert.deepStrictEqual(getIntervalPlan(k, { timeZone: tz, aggregateFrom: 'none' }), nat(k, getIntervals()[k].dataSec, null), `${k} ${tz}`)
        }
        //none 不要求固定偏移, 有日光節約之時區亦可
        assert.deepStrictEqual(getIntervalPlan('4hr', { timeZone: 'America/New_York', aggregateFrom: 'none' }), nat('4hr', 14400, null))
    })

    it('I3 auto: 對齊者直接下載, 不對齊者取能整除且對齊之最大原生週期; 資料夾名含偏移與 dayStart', function() {
        //規格: UTC+8 之 1day 為 8hr 合併 3 根, UTC+9 為 1hr 合併 24 根, UTC+5:30 為 30m 合併 48 根; 原生格線與 timeZone 之界線對齊者直接下載; 合併之序列存於 '<週期鍵>_tz<±HHMM>_d<YYYYMMDD>_from<基底>', 基底存於 '<基底>_tz<±HHMM>_d<YYYYMMDD>'
        let cases = [
            [['1day', { timeZone: 'Asia/Taipei' }], agg('1day', '+0800', '8hr', 3, 86400, 480)],
            [['1day', {}], agg('1day', '+0800', '8hr', 3, 86400, 480)],
            [['1day', { timeZone: 'Asia/Taipei', dayStart: '2022-07-01' }], agg('1day', '+0800', '8hr', 3, 86400, 480, '20220701')],
            [['1day', { timeZone: 'Asia/Tokyo' }], agg('1day', '+0900', '1hr', 24, 86400, 540)],
            [['1day', { timeZone: 'Asia/Kolkata' }], agg('1day', '+0530', '30m', 48, 86400, 330)],
            [['1day', { timeZone: 'Asia/Kathmandu' }], agg('1day', '+0545', '15m', 96, 86400, 345)],
            [['1day', { timeZone: 'Etc/GMT+5' }], agg('1day', '-0500', '1hr', 24, 86400, -300)],
            [['1day', { timeZone: 'UTC' }], nat('1day', 86400, 0)],
            [['12hr', { timeZone: 'Asia/Taipei' }], agg('12hr', '+0800', '4hr', 3, 43200, 480)],
            [['6hr', { timeZone: 'Asia/Taipei' }], agg('6hr', '+0800', '2hr', 3, 21600, 480)],
            [['8hr', { timeZone: 'Asia/Taipei' }], nat('8hr', 28800, 480)],
            [['2hr', { timeZone: 'Asia/Taipei' }], nat('2hr', 7200, 480)],
            [['3m', { timeZone: 'Asia/Kathmandu' }], nat('3m', 180, 345)],
            [['1week', { timeZone: 'Asia/Taipei' }], agg('1week', '+0800', '8hr', 21, 604800, 480)],
            [['1week', { timeZone: 'UTC' }], nat('1week', 604800, 0)],
            [['4hr', { timeZone: 'Asia/Kolkata', aggregateFrom: 'auto' }], agg('4hr', '+0530', '30m', 8, 14400, 330)],
            [['4hr', { timeZone: 'Asia/Taipei', aggregateFrom: 'auto' }], nat('4hr', 14400, 480)],
            [['30m', { timeZone: 'Asia/Kathmandu', aggregateFrom: 'auto' }], agg('30m', '+0545', '15m', 2, 1800, 345)],
        ]
        for (let [args, exp] of cases) {
            assert.deepStrictEqual(getIntervalPlan(...args), exp, JSON.stringify(args))
        }
    })

    it('I3b 時區之偏移為整分鐘時, 任何週期鍵與時區皆能取得基底(auto 不會找不到基底)', function() {
        //規格: auto 對不對齊者取能整除目標且對齊之最大原生週期; 偏移為整分鐘, 1m 恆為候選(getIntervalPlan 以此為不變式, 無額外之找不到基底之分支)
        for (let tz of ['UTC', 'Asia/Taipei', 'Asia/Kolkata', 'Asia/Kathmandu', 'Etc/GMT+12', 'Etc/GMT-14', 'Asia/Tehran', 'Australia/Eucla', 'Pacific/Marquesas', 'America/St_Johns']) {
            for (let k of KEYS) {
                let p = null
                try {
                    p = getIntervalPlan(k, { timeZone: tz, dayStart: '2026-01-01' })
                }
                catch (err) {
                    //只允許有日光節約者須合併而拋出之固定偏移錯誤
                    assert.strictEqual(err.message, MSG_DST, `${k} ${tz}`)
                    continue
                }
                if (p.mode === 'aggregate') {
                    assert.ok(p.count > 1 && Number.isInteger(p.count), `${k} ${tz}`)
                    assert.strictEqual(p.count * getIntervals()[p.base].dataSec, p.dataSec, `${k} ${tz}`)
                }
            }
        }
    })

    it('I4 基底週期鍵: 能整除且對齊者合併, 與目標相同且對齊者直接下載, 否則拋錯; none 直接下載', function() {
        //規格: 週期鍵為基底, 須能整除目標週期且其格線與 timeZone 之界線對齊, 否則拋錯; 與目標週期相同且於各偏移下皆對齊時即直接下載
        let tz = 'Asia/Taipei'
        assert.deepStrictEqual(getIntervalPlan('1day', { timeZone: tz, aggregateFrom: '4hr' }), agg('1day', '+0800', '4hr', 6, 86400, 480))
        assert.deepStrictEqual(getIntervalPlan('1day', { timeZone: tz, aggregateFrom: '1hr' }), agg('1day', '+0800', '1hr', 24, 86400, 480))
        assert.deepStrictEqual(getIntervalPlan('1day', { timeZone: tz, aggregateFrom: '1m' }), agg('1day', '+0800', '1m', 1440, 86400, 480))
        assert.deepStrictEqual(getIntervalPlan('1day', { timeZone: 'UTC', aggregateFrom: '1day' }), nat('1day', 86400, 0))
        assert.deepStrictEqual(getIntervalPlan('1day', { timeZone: tz, aggregateFrom: 'none' }), nat('1day', 86400, null))
        //3m 能整除 1day 且 8 小時為 3 分鐘之整數倍, 可用
        assert.strictEqual(getIntervalPlan('1day', { timeZone: tz, aggregateFrom: '3m' }).count, 480)
        //12hr、1day 之格線不在台北之 00:00; 8hr 不能整除 12hr; 1week 長於 1day; 1day 之格線不在台北之週一 00:00
        for (let [k, af] of [['1day', '12hr'], ['12hr', '8hr'], ['1day', '1week'], ['1day', '1day'], ['1week', '1day'], ['4hr', '4hr']]) {
            let tzk = k === '4hr' ? 'Asia/Kolkata' : tz
            assert.throws(() => getIntervalPlan(k, { timeZone: tzk, aggregateFrom: af }), (err) => err.message === MSG_AF_ALIGN, `${k} ${af}`)
        }
    })

    it('I4b aggregateFrom 給了而無效即拋(非字串、非 auto/none/週期鍵含原型鏈名), 訊息不回顯輸入值; undefined 與 null 視為未給', function() {
        //規格: aggregateFrom 給了而無效即拋(決定資料口徑, 不改用預設), 訊息 'invalid opt.aggregateFrom: must be one of auto, none, <各週期鍵>' 且不帶輸入值; undefined 與 null 視為未給
        for (let af of ['abc', '1d', '1h', 8, true, false, {}, [], '', ' auto', 'AUTO', 'constructor', 'toString', '__proto__', 'hasOwnProperty', NaN]) {
            assert.throws(() => getIntervalPlan('1day', { timeZone: 'Asia/Taipei', aggregateFrom: af }), (err) => err.message === MSG_AF, String(af))
            //不論對齊與否皆拋(UTC 之 1day 本可直接下載)
            assert.throws(() => getIntervalPlan('1day', { timeZone: 'UTC', aggregateFrom: af }), (err) => err.message === MSG_AF, `UTC ${String(af)}`)
        }
        let secret = 'zzzSecretKey9'
        assert.throws(() => getIntervalPlan('1day', { aggregateFrom: secret }), (err) => err.message.indexOf(secret) < 0 && err.message === MSG_AF)
        assert.deepStrictEqual(getIntervalPlan('1day', { aggregateFrom: undefined }), getIntervalPlan('1day', {}))
        assert.deepStrictEqual(getIntervalPlan('1day', { aggregateFrom: null }), getIntervalPlan('1day', {}))
        //opt 未給或為 null 視為 {}
        assert.deepStrictEqual(getIntervalPlan('1day'), getIntervalPlan('1day', {}))
        assert.deepStrictEqual(getIntervalPlan('1day', null), getIntervalPlan('1day', {}))
    })

    it('I5 週期鍵無效時拋錯: 訊息為 must be one of 各週期鍵, 不回顯輸入值(含原型鏈名與非字串)', function() {
        //規格: 週期鍵須為週期表所列, 訊息 'invalid interval: must be one of <各週期鍵>' 不帶輸入值
        for (let k of ['3day', '1month', '1h', '1d', '', ' 1m', '1M', '1s', 'constructor', 'toString', '__proto__', 'hasOwnProperty', null, undefined, 1, {}, ['1m']]) {
            assert.throws(() => getIntervalPlan(k), (err) => err.message === MSG_INTERVAL, String(k))
        }
        let secret = 'zzzSecretKey9'
        assert.throws(() => getIntervalPlan(secret), (err) => err.message.indexOf(secret) < 0 && err.message === MSG_INTERVAL)
    })

    it('I6 偏移: 無變動之時區回傳偏移; 有日光節約或期間內改過偏移者須合併時拋錯; 無效之時區拋錯', function() {
        //規格: 期間(dayStart 前 1 天至現在後 366 天)內偏移有變動(日光節約時間或歷史上改過偏移)者須合併時拋錯; getOffsets 回傳期間內出現之各偏移
        assert.deepStrictEqual(getOffsets('Asia/Taipei', '2020-01-01'), [480])
        assert.deepStrictEqual(getOffsets('Asia/Kolkata', '2020-01-01'), [330])
        assert.deepStrictEqual(getOffsets('Etc/GMT+5', '2020-01-01'), [-300])
        assert.deepStrictEqual(getOffsets('UTC', '2020-01-01'), [0])
        assert.deepStrictEqual(getOffsets('America/New_York', '2020-01-01'), [-300, -240])
        assert.deepStrictEqual(getOffsets('Asia/Taipei', '1975-01-01'), [480, 540])
        //由小到大(南半球之時區於期間起點為夏令之較大偏移, 取樣順序與大小順序相反)
        assert.deepStrictEqual(getOffsets('Australia/Sydney', '2020-01-01'), [600, 660])
        let today = new Date().toISOString().slice(0, 10)
        for (let [tz, ds] of [['America/New_York', '2020-01-01'], ['America/New_York', today], ['Europe/London', today], ['Australia/Sydney', today], ['Asia/Taipei', '1975-01-01']]) {
            assert.throws(() => getIntervalPlan('1day', { timeZone: tz, dayStart: ds }), (err) => err.message === MSG_DST, `${tz} ${ds}`)
        }
        //無效之時區(含不回顯輸入值)
        for (let tz of ['Bad/Zone', 'UTC+8', 'zzzSecretZone9']) {
            assert.throws(() => getOffsets(tz), (err) => err.message === MSG_IANA, tz)
            for (let af of [undefined, 'none', 'auto', '1hr']) {
                assert.throws(() => getIntervalPlan('1day', { timeZone: tz, aggregateFrom: af }), (err) => err.message === MSG_IANA, `${tz} ${af}`)
            }
        }
        assert.throws(() => getOffsets(''), (err) => err.message === 'invalid opt.timeZone: must be a non-empty string')
        //偏移非整分鐘(歷史上之 LMT)
        assert.throws(() => getOffsets('Africa/Monrovia', '1960-01-01'), (err) => err.message === MSG_WHOLE)
    })

    it('I7 有日光節約之時區: auto 而原生格線於各偏移下皆對齊者直接下載(偏移為 null), 須合併者拋錯(含既有六鍵之 4hr)', function() {
        //規格: 'auto' 而目標之原生格線於期間內出現之各偏移下皆與界線對齊者直接下載(有日光節約之時區亦可, 例如 3m、1hr); 須合併時 timeZone 須為固定偏移
        let ny = 'America/New_York'
        assert.deepStrictEqual(getIntervalPlan('3m', { timeZone: ny }), nat('3m', 180, null))
        for (let k of ['1m', '5m', '15m', '30m', '1hr']) {
            assert.deepStrictEqual(getIntervalPlan(k, { timeZone: ny }), nat(k, getIntervals()[k].dataSec, null), k)
        }
        assert.deepStrictEqual(getIntervalPlan('1hr', { timeZone: ny, aggregateFrom: '1hr' }), nat('1hr', 3600, null))
        assert.deepStrictEqual(getIntervalPlan('30m', { timeZone: 'Europe/London', aggregateFrom: 'auto' }), nat('30m', 1800, null))
        for (let [k, tz, af] of [['1day', ny, undefined], ['2hr', ny, undefined], ['4hr', ny, undefined], ['4hr', ny, 'auto'], ['12hr', 'Europe/London', undefined], ['1day', ny, '1hr'], ['1hr', 'Australia/Lord_Howe', undefined]]) {
            assert.throws(() => getIntervalPlan(k, { timeZone: tz, aggregateFrom: af }), (err) => err.message === MSG_DST, `${k} ${tz} ${af}`)
        }
    })

    it('I8 偏移字串: 執行環境支援者照常, 絕對值小於 30 分之非零偏移拋專屬之錯誤; 不支援者拋 IANA 時區名之錯誤', function() {
        //規格: timeZone 可給固定偏移(須執行環境之 Intl 支援, 不支援時與無效時區同訊息); 絕對值小於 30 分之非零偏移不支援(時間函式庫會把絕對值 16 以內之偏移值當成小時)
        if (supportsOffsetTz()) {
            assert.deepStrictEqual(getIntervalPlan('1day', { timeZone: '+08:00' }), agg('1day', '+0800', '8hr', 3, 86400, 480))
            assert.deepStrictEqual(getIntervalPlan('1day', { timeZone: '-03:30' }), agg('1day', '-0330', '30m', 48, 86400, -210))
            assert.deepStrictEqual(getOffsets('+00:30'), [30])
            for (let tz of ['+00:15', '-00:15', '+00:16', '+00:29']) {
                for (let af of [undefined, 'none']) {
                    assert.throws(() => getIntervalPlan('1day', { timeZone: tz, aggregateFrom: af }), (err) => err.message === MSG_SMALL, `${tz} ${af}`)
                }
            }
            assert.deepStrictEqual(getOffsets('+00:00'), [0])
        }
        else {
            for (let tz of ['+08:00', '+00:15']) {
                assert.throws(() => getIntervalPlan('1day', { timeZone: tz }), (err) => err.message === MSG_IANA, tz)
            }
        }
    })

    it('I9 WDwdataBinace() 掛出 getIntervalPlan(不連網), 與 intervals.mjs 之同一函數', function() {
        //規格: README 〈Intervals and day boundary〉: 可用 getIntervalPlan(interval, opt) 預先查得取得方式與資料夾名(不連網), 亦掛於 WDwdataBinace()
        let wdd = WDwdataBinace()
        assert.deepStrictEqual(Object.keys(wdd).sort(), ['downloadData', 'getIntervalPlan', 'saveData', 'syncData'])
        assert.strictEqual(wdd.getIntervalPlan, getIntervalPlan)
        assert.deepStrictEqual(wdd.getIntervalPlan('1day', { timeZone: 'Asia/Taipei', dayStart: '2022-07-01' }), agg('1day', '+0800', '8hr', 3, 86400, 480, '20220701'))
    })

})
