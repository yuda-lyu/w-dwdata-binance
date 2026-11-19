import assert from 'assert'
import fs from 'fs'
import path from 'path'
import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { getGapOpts, gridOpens, GAP_FILE, fpGapsOf, parseGapFile, openGapStore, applyAttempt, readGaps } from '../src/gaps.mjs'
import aggregateData from '../src/aggregateData.mjs'
import { getIntervalPlan } from '../src/intervals.mjs'


ot.extend(utc)
ot.extend(timezone)


//規格: sgud/rule/rulebook.md W14(每次執行每根至多1次有效觀察)、W15(標註之三條件、清零、紀錄檔之格式與位置、檢查、原子寫入、重置)、W16(readGaps、aggregate.missing之cause與causes)

let fdRoot = './test/_tmp/unit-gaps'
let H = 3600 * 1000
let D = 24 * H
let T = Date.parse('2026-03-01T00:00:00Z')
let go = getGapOpts({})

//rec, 紀錄之預設欄位
let recOf = (o) => ({ state: 'pending', validCount: 1, firstValid: T, lastValid: T, lastKind: 'missing', lastHttpStatus: 200, lastCode: null, uncounted: 0, lastUncountedKind: null, markedAt: null, ...o })

//obs, 一次有效觀察(200 陣列而缺根)
let obs = (bars, o, tObs, extra = {}) => applyAttempt(bars, { expected: [o], have: new Set(), counted: true, kind: 'ok', httpStatus: 200, code: null, tObs, ...extra }, extra.go || go)

//unobs, 一次不算觀察
let unobs = (bars, o, tObs, kind = 'network') => applyAttempt(bars, { expected: [o], have: new Set(), counted: false, kind, httpStatus: null, code: 'ECONNRESET', tObs }, go)

//writeGaps, 經紀錄物件寫出資料夾之紀錄檔: byTag 為 { tag: Map(開盤毫秒 -> 紀錄) }
let writeGaps = (fd, meta, byTag) => {
    fs.mkdirSync(fd, { recursive: true })
    let gs = openGapStore(fd, meta)
    for (let [tag, bars] of Object.entries(byTag)) {
        let m = gs.barsOf(tag)
        for (let [o, rec] of bars) {
            m.set(o, rec)
        }
        gs.touch(tag)
    }
    gs.save()
    return gs
}

//readJson, 讀紀錄檔
let readJson = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'))

//countReads, 執行 f 期間對某路徑之 fs.readFileSync 次數
let countReads = (fp, f) => {
    let n = 0
    let rf = fs.readFileSync
    fs.readFileSync = (p, ...args) => {
        if (path.resolve(String(p)) === path.resolve(fp)) {
            n++
        }
        return rf(p, ...args)
    }
    try {
        f()
    }
    finally {
        fs.readFileSync = rf
    }
    return n
}


describe('unit-gaps', function() {

    after(function() {
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

    it('U1 gridOpens: 起訖內之UTC原生格點(含終點), 1week開於週一UTC 00:00', function() {
        //W14: 應有之根以UTC格點計(週期秒數之整數倍, 1week加4天錨點)
        let s = Date.parse('2026-03-01T01:00:00Z')
        assert.deepStrictEqual(gridOpens(s, s + 11 * H, '4hr'), [Date.parse('2026-03-01T04:00:00Z'), Date.parse('2026-03-01T08:00:00Z'), Date.parse('2026-03-01T12:00:00Z')])
        assert.deepStrictEqual(gridOpens(s - H, s + 3 * H, '4hr'), [s - H, s + 3 * H])
        let w = gridOpens(Date.parse('2026-02-25T00:00:00Z'), Date.parse('2026-03-12T00:00:00Z'), '1week')
        assert.deepStrictEqual(w.map((v) => new Date(v).toISOString()), ['2026-03-02T00:00:00.000Z', '2026-03-09T00:00:00.000Z'])
        assert.strictEqual(new Date(w[0]).getUTCDay(), 1)
    })

    it('U2 有效觀察之累計與標註: 2次即使相隔7天不標註、第3次標註; 3次而相隔6天23時59分59.999秒不標註、滿7天標註', function() {
        //W15: 標註 = 有效觀察 ≥ noDataTimes(3) 且首末相隔 ≥ timeNoData(7天), 於有效觀察之當下判定
        let o = T - 30 * D
        let bars = new Map()
        obs(bars, o, T)
        assert.deepStrictEqual(bars.get(o), recOf({}))
        obs(bars, o, T + 7 * D)
        assert.deepStrictEqual([bars.get(o).state, bars.get(o).validCount], ['pending', 2])
        obs(bars, o, T + 7 * D + H)
        assert.deepStrictEqual(bars.get(o), recOf({ state: 'nodata', validCount: 3, lastValid: T + 7 * D + H, markedAt: T + 7 * D + H }))

        bars = new Map()
        obs(bars, o, T)
        obs(bars, o, T + D)
        obs(bars, o, T + 7 * D - 1)
        assert.deepStrictEqual([bars.get(o).state, bars.get(o).validCount, bars.get(o).markedAt], ['pending', 3, null])
        obs(bars, o, T + 7 * D)
        assert.deepStrictEqual([bars.get(o).state, bars.get(o).validCount, bars.get(o).firstValid, bars.get(o).markedAt], ['nodata', 4, T, T + 7 * D])
    })

    it('U3 最近一次為不算觀察時不標註(不算觀察不延長相隔、不計次), 其後之有效觀察才標註; 不算觀察不新增紀錄', function() {
        //W15 第3條件: 最近一次嘗試須為有效觀察; W14: 不算觀察只累計uncounted
        let o = T - 30 * D
        let bars = new Map()
        unobs(bars, o, T - D)
        assert.strictEqual(bars.size, 0)
        obs(bars, o, T)
        obs(bars, o, T + D)
        obs(bars, o, T + 2 * D)
        let changed = unobs(bars, o, T + 8 * D, 'timeout')
        assert.strictEqual(changed, true)
        assert.deepStrictEqual(bars.get(o), recOf({ validCount: 3, lastValid: T + 2 * D, uncounted: 1, lastUncountedKind: 'timeout' }))
        obs(bars, o, T + 8 * D, { kind: 'httpError', httpStatus: 503, code: -1001 })
        assert.deepStrictEqual(bars.get(o), recOf({ state: 'nodata', validCount: 4, lastValid: T + 8 * D, lastKind: 'httpError', lastHttpStatus: 503, lastCode: -1001, uncounted: 1, lastUncountedKind: 'timeout', markedAt: T + 8 * D }))
    })

    it('U4 取得數據即清零(含已標註者); 已標註者再缺不變; 選項 noDataTimes 與 timeNoData', function() {
        //W15: 任何一次嘗試取得該根 ⇒ 刪除該根之紀錄; 已標註者不再累計
        let o1 = T - 30 * D
        let o2 = o1 + 4 * H
        let bars = new Map([[o1, recOf({ validCount: 2 })], [o2, recOf({ state: 'nodata', validCount: 3, markedAt: T })]])
        let changed = applyAttempt(bars, { expected: [o1, o2], have: new Set([o1]), counted: true, kind: 'ok', httpStatus: 200, code: null, tObs: T + D }, go)
        assert.strictEqual(changed, true)
        assert.deepStrictEqual([...bars.keys()], [o2])
        assert.deepStrictEqual(bars.get(o2), recOf({ state: 'nodata', validCount: 3, markedAt: T }))
        changed = applyAttempt(bars, { expected: [o2], have: new Set(), counted: true, kind: 'ok', httpStatus: 200, code: null, tObs: T + 2 * D }, go)
        assert.strictEqual(changed, false)
        applyAttempt(bars, { expected: [], have: new Set([o2]), counted: false, kind: 'network', httpStatus: null, code: null, tObs: T + 2 * D }, go)
        assert.strictEqual(bars.size, 0)
        let g1 = getGapOpts({ noDataTimes: 1, timeNoData: 0 })
        bars = new Map()
        obs(bars, o1, T, { go: g1 })
        assert.strictEqual(bars.get(o1).state, 'nodata')
        let g2 = getGapOpts({ noDataTimes: 2, timeNoData: D })
        bars = new Map()
        obs(bars, o1, T, { go: g2 })
        obs(bars, o1, T + D - 1, { go: g2 })
        assert.strictEqual(bars.get(o1).state, 'pending')
        obs(bars, o1, T + D, { go: g2 })
        assert.strictEqual(bars.get(o1).state, 'nodata')
    })

    it('U5 紀錄檔之格式: 每資料夾一個(_gaps.json), 各範圍帶所屬分段 tag, 同一分段內連續且紀錄相同之根合併為範圍(跨分段不合併), 每範圍一列; 讀回相同; 無紀錄時刪檔', function() {
        //W15 紀錄檔: { v, interval, timeZone, ranges: [{ tag, from, to, n, state, validCount, firstValid, lastValid, lastKind, lastHttpStatus, lastCode, uncounted, lastUncountedKind, markedAt }] }
        let fd = path.resolve(fdRoot, 'U5')
        let meta = { interval: '4hr', timeZone: 'Asia/Taipei' }
        assert.strictEqual(GAP_FILE, '_gaps.json')
        let fp = fpGapsOf(fd)
        assert.strictEqual(path.basename(fp), '_gaps.json')
        assert.strictEqual(path.dirname(fp), fd)
        //分段A(台北 2026-01-25 00:00 起, 8天)與分段B(2026-02-02 00:00 起): A之末根(UTC 2026-02-01T12:00)與B之首根(UTC 2026-02-01T16:00)相鄰且紀錄相同, 但屬不同分段, 不合併
        let tagA = '20260125000000'
        let tagB = '20260202000000'
        let oA = Date.parse('2026-01-25T00:00:00Z')
        let barsA = new Map()
        for (let i = 0; i < 3; i++) {
            barsA.set(oA + i * 4 * H, recOf({}))
        }
        barsA.set(oA + 4 * 4 * H, recOf({}))
        barsA.set(oA + 5 * 4 * H, recOf({ validCount: 2 }))
        barsA.set(Date.parse('2026-02-01T12:00:00Z'), recOf({}))
        let barsB = new Map([[Date.parse('2026-02-01T16:00:00Z'), recOf({})], [Date.parse('2026-02-02T00:00:00Z'), recOf({ state: 'nodata', validCount: 3, markedAt: T })]])
        let gs = writeGaps(fd, meta, { [tagB]: barsB, [tagA]: barsA })
        assert.strictEqual(gs.invalid(), false)
        let j = readJson(fp)
        let base = { state: 'pending', validCount: 1, firstValid: '2026-03-01T00:00:00.000Z', lastValid: '2026-03-01T00:00:00.000Z', lastKind: 'missing', lastHttpStatus: 200, lastCode: null, uncounted: 0, lastUncountedKind: null, markedAt: null }
        assert.deepStrictEqual(j, {
            v: 1,
            interval: '4hr',
            timeZone: 'Asia/Taipei',
            ranges: [
                { tag: tagA, from: '2026-01-25T08:00:00', to: '2026-01-25T16:00:00', n: 3, ...base },
                { tag: tagA, from: '2026-01-26T00:00:00', to: '2026-01-26T00:00:00', n: 1, ...base },
                { tag: tagA, from: '2026-01-26T04:00:00', to: '2026-01-26T04:00:00', n: 1, ...base, validCount: 2 },
                { tag: tagA, from: '2026-02-01T20:00:00', to: '2026-02-01T20:00:00', n: 1, ...base },
                { tag: tagB, from: '2026-02-02T00:00:00', to: '2026-02-02T00:00:00', n: 1, ...base },
                { tag: tagB, from: '2026-02-02T08:00:00', to: '2026-02-02T08:00:00', n: 1, ...base, state: 'nodata', validCount: 3, markedAt: '2026-03-01T00:00:00.000Z' },
            ],
        })
        assert.deepStrictEqual(Object.keys(j.ranges[0]), ['tag', 'from', 'to', 'n', 'state', 'validCount', 'firstValid', 'lastValid', 'lastKind', 'lastHttpStatus', 'lastCode', 'uncounted', 'lastUncountedKind', 'markedAt'])
        //每範圍一列(檔頭 5 列 + 6 範圍 + 結尾 2 列), 且每列自成合法 JSON
        let lines = fs.readFileSync(fp, 'utf8').split('\n')
        assert.strictEqual(lines.length, 5 + 6 + 2)
        let rl = lines.slice(5, 11)
        for (let i = 0; i < rl.length; i++) {
            assert.deepStrictEqual(JSON.parse(rl[i].trim().replace(/,$/, '')), j.ranges[i])
        }
        //讀回相同(展開為逐根後與寫入者相同)
        let gs2 = openGapStore(fd, meta)
        assert.deepStrictEqual(gs2.barsOf(tagA), barsA)
        assert.deepStrictEqual(gs2.barsOf(tagB), barsB)
        assert.deepStrictEqual(gs2.list().map((v) => v.tag), [tagA, tagA, tagA, tagA, tagB, tagB])
        //無紀錄時刪檔; 不存在時再存不拋
        gs2.resetTags(new Set([tagA, tagB]))
        assert.strictEqual(gs2.save(), true)
        assert.strictEqual(fs.existsSync(fp), false)
        assert.strictEqual(gs2.save(), false)
        assert.deepStrictEqual(fs.readdirSync(fd), [])
    })

    it('U6 getGapOpts: 預設; noDataTimes 與 timeNoData 給了而無效即拋(訊息不帶輸入值); 數字字串轉為數值; useResetGaps 只有 true 為啟用', function() {
        //W15 選項; 輸入檢測規格 K7(數字字串)、K4(使用轉換值)、§11 決定資料口徑之 opt(noDataTimes、timeNoData 決定永久標註)、K3(useResetGaps 依預設)
        assert.deepStrictEqual(getGapOpts({}), { noDataTimes: 3, timeNoData: 604800000, useResetGaps: false })
        assert.deepStrictEqual(getGapOpts(), { noDataTimes: 3, timeNoData: 604800000, useResetGaps: false })
        assert.deepStrictEqual(getGapOpts(null), { noDataTimes: 3, timeNoData: 604800000, useResetGaps: false })
        assert.deepStrictEqual(getGapOpts({ noDataTimes: null, timeNoData: undefined, useResetGaps: true }), { noDataTimes: 3, timeNoData: 604800000, useResetGaps: true })
        assert.deepStrictEqual(getGapOpts({ noDataTimes: 1, timeNoData: 0 }), { noDataTimes: 1, timeNoData: 0, useResetGaps: false })
        //數字字串(去頭尾空白、小數點後全為0、科學記號之整數)轉為數值
        assert.deepStrictEqual(getGapOpts({ noDataTimes: '5', timeNoData: ' 1e3 ' }), { noDataTimes: 5, timeNoData: 1000, useResetGaps: false })
        assert.deepStrictEqual(getGapOpts({ noDataTimes: '2.0', timeNoData: '0' }), { noDataTimes: 2, timeNoData: 0, useResetGaps: false })
        //無效 ⇒ 拋(不改用預設), 訊息為 'invalid opt.<名稱>: must be <種類>' 且不帶輸入值
        let secret = 'SECRET-VALUE-9917'
        //(上限為安全整數: 以極大之次數表示「不標註」為合法用法)
        assert.strictEqual(getGapOpts({ noDataTimes: 4294967296 }).noDataTimes, 4294967296)
        assert.strictEqual(getGapOpts({ noDataTimes: Number.MAX_SAFE_INTEGER }).noDataTimes, Number.MAX_SAFE_INTEGER)
        assert.strictEqual(getGapOpts({ timeNoData: Number.MAX_SAFE_INTEGER }).timeNoData, Number.MAX_SAFE_INTEGER)
        for (let v of [0, -1, 1.5, '0', 'x', '', ' ', '0x10', '0b11', '1,000', '１２', Infinity, -Infinity, NaN, true, false, {}, [], [3], () => 3, 2 ** 53, '9007199254740993', secret]) {
            assert.throws(() => getGapOpts({ noDataTimes: v }), (err) => err.message === 'invalid opt.noDataTimes: must be a positive integer' && err.message.indexOf(secret) < 0, `noDataTimes=${String(v)}`)
        }
        for (let v of [-1, 0.5, '-1', 'abc', '', '0x10', Infinity, NaN, false, {}, [], 2 ** 53, secret]) {
            assert.throws(() => getGapOpts({ timeNoData: v }), (err) => err.message === 'invalid opt.timeNoData: must be a non-negative integer' && err.message.indexOf(secret) < 0, `timeNoData=${String(v)}`)
        }
        //useResetGaps: 只有 true 為啟用, 其餘(含 'true'、1、'y')視為未給, 不拋
        for (let v of [false, 'true', 1, 0, 'y', '', null, undefined, {}, [], 'TRUE']) {
            assert.strictEqual(getGapOpts({ useResetGaps: v }).useResetGaps, false, String(v))
        }
        assert.strictEqual(getGapOpts({ useResetGaps: true }).useResetGaps, true)
        //不改寫輸入
        let o = { noDataTimes: '5' }
        getGapOpts(o)
        assert.deepStrictEqual(o, { noDataTimes: '5' })
    })

    it('U7 readGaps: 讀資料夾之紀錄檔(附tag, 依分段與起點排序), 不被分段檔或其他檔名影響; 資料夾或紀錄檔不存在、不合格為空陣列', function() {
        //W16: readGaps(fdData, name, type, folder)
        let fd = path.resolve(fdRoot, 'N', 'price', '4hr')
        let o0 = Date.parse('2026-01-25T00:00:00Z')
        writeGaps(fd, { interval: '4hr', timeZone: 'UTC' }, {
            20260202000000: new Map([[o0 + 8 * D, recOf({ state: 'nodata', validCount: 3, markedAt: T })]]),
            20260125000000: new Map([[o0 + 4 * H, recOf({})]]),
        })
        fs.writeFileSync(`${fd}/20260125000000.csv`, 'x', 'utf8')
        fs.writeFileSync(`${fd}/note.gaps.json`, '{}', 'utf8')
        fs.writeFileSync(`${fd}/20260125000000.gaps.json`, 'broken', 'utf8')
        let r = readGaps(fdRoot, 'N', 'price', '4hr')
        assert.deepStrictEqual(r.map((v) => [v.tag, v.from, v.to, v.n, v.state, v.markedAt]), [
            ['20260125000000', '2026-01-25T04:00:00', '2026-01-25T04:00:00', 1, 'pending', null],
            ['20260202000000', '2026-02-02T00:00:00', '2026-02-02T00:00:00', 1, 'nodata', '2026-03-01T00:00:00.000Z'],
        ])
        assert.deepStrictEqual(readGaps(fdRoot, 'N', 'price', '1hr'), [])
        //紀錄檔不合格(整檔視為無紀錄)
        fs.writeFileSync(fpGapsOf(fd), 'broken', 'utf8')
        assert.deepStrictEqual(readGaps(fdRoot, 'N', 'price', '4hr'), [])
        for (let [args, msg] of [[['', 'N', 'p', 'f'], 'invalid fdData'], [[fdRoot, '', 'p', 'f'], 'invalid name'], [[fdRoot, 'N', '', 'f'], 'invalid type'], [[fdRoot, 'N', 'p', ''], 'invalid folder']]) {
            assert.throws(() => readGaps(...args), (err) => err.message === msg)
        }
    })

    it('U8 紀錄檔逐範圍檢查: 欄位不合格(檔頭、tag、時刻不可解析、次數非正整數或超過上限、n 與起訖不一致或過大、from 不在格線或不在所屬分段、範圍重疊、狀態與 markedAt 不符)者整檔視為無紀錄, 且不耗時', function() {
        //W15: 讀紀錄檔時逐範圍檢查欄位, 不合格者視為無紀錄(不拋錯、不提早標註)
        let fd = path.resolve(fdRoot, 'U8')
        let meta = { interval: '4hr', timeZone: 'UTC' }
        let fp = fpGapsOf(fd)
        let o0 = Date.parse('2026-01-25T08:00:00Z')
        let good = new Map([[o0, recOf({})], [o0 + 4 * H, recOf({ state: 'nodata', validCount: 3, markedAt: T })]])
        let good2 = new Map([[Date.parse('2026-02-02T04:00:00Z'), recOf({ validCount: 2 })]])
        writeGaps(fd, meta, { 20260125000000: good, 20260202000000: good2 })
        let j0 = readJson(fp)
        assert.strictEqual(j0.ranges.length, 3)
        let gs = openGapStore(fd, meta)
        assert.strictEqual(gs.invalid(), false)
        assert.deepStrictEqual(gs.barsOf('20260125000000'), good)
        assert.deepStrictEqual(gs.barsOf('20260202000000'), good2)
        let bad = [
            ['firstValid null', (j) => {
                j.ranges[0].firstValid = null
            }],
            ['firstValid 非時刻', (j) => {
                j.ranges[0].firstValid = 'garbage'
            }],
            ['lastValid 缺', (j) => {
                delete j.ranges[0].lastValid
            }],
            ['validCount 0', (j) => {
                j.ranges[0].validCount = 0
            }],
            ['validCount 字串', (j) => {
                j.ranges[0].validCount = '1'
            }],
            ['validCount 超過上限', (j) => {
                j.ranges[0].validCount = 2e9
            }],
            ['uncounted 負', (j) => {
                j.ranges[0].uncounted = -1
            }],
            ['n 過大', (j) => {
                j.ranges[0].n = 3000000
            }],
            ['n 與 to 不一致', (j) => {
                j.ranges[0].n = 2
            }],
            ['to 與 n 不一致', (j) => {
                j.ranges[0].to = '2026-01-25T16:00:00'
            }],
            ['to 不可解析', (j) => {
                j.ranges[0].n = 2
                j.ranges[0].to = 'garbage'
            }],
            ['n 為 2 而 to 與 from 為同一字串(其餘範圍不相鄰, 重疊檢查抓不到)', (j) => {
                j.ranges[2].n = 2
            }],
            ['n 非整數', (j) => {
                j.ranges[0].n = 1.5
            }],
            ['n 為 0', (j) => {
                j.ranges[0].n = 0
            }],
            ['from 不在格線上', (j) => {
                j.ranges[0].from = '2026-01-25T09:00:00'
                j.ranges[0].to = '2026-01-25T09:00:00'
            }],
            ['from 不可解析', (j) => {
                j.ranges[0].from = 'garbage'
            }],
            ['from 不屬所屬分段(於前一段)', (j) => {
                j.ranges[0].from = '2026-01-24T08:00:00'
                j.ranges[0].to = '2026-01-24T08:00:00'
            }],
            ['from 於段外(晚於所屬分段)', (j) => {
                j.ranges[0].from = '2026-02-02T08:00:00'
                j.ranges[0].to = '2026-02-02T08:00:00'
            }],
            ['範圍跨出所屬分段之末', (j) => {
                //tag 為 20260125000000 之分段止於 2026-02-01T23:59:59Z, n 為 3 之範圍自 20:00 起至次日 04:00
                j.ranges[2].tag = '20260125000000'
                j.ranges[2].n = 3
                j.ranges[2].from = '2026-02-01T20:00:00'
                j.ranges[2].to = '2026-02-02T04:00:00'
            }],
            ['範圍重疊(同 tag)', (j) => {
                j.ranges[1] = { ...j.ranges[0] }
            }],
            ['tag 缺', (j) => {
                delete j.ranges[0].tag
            }],
            ['tag 非字串', (j) => {
                j.ranges[0].tag = 20260125000000
            }],
            ['tag 位數不符', (j) => {
                j.ranges[0].tag = '2026012500000'
            }],
            ['tag 含非數字', (j) => {
                j.ranges[0].tag = '2026012500000x'
            }],
            ['tag 指向另一分段(from 不屬之)', (j) => {
                j.ranges[0].tag = '20260202000000'
            }],
            ['state 未知', (j) => {
                j.ranges[0].state = 'gone'
            }],
            ['nodata 而無 markedAt', (j) => {
                j.ranges[1].markedAt = null
            }],
            ['pending 而有 markedAt', (j) => {
                j.ranges[0].markedAt = j.ranges[1].markedAt
            }],
            ['lastKind 未知', (j) => {
                j.ranges[0].lastKind = 'x'
            }],
            ['lastHttpStatus 超出範圍', (j) => {
                j.ranges[0].lastHttpStatus = 999
            }],
            ['lastCode 為物件', (j) => {
                j.ranges[0].lastCode = { x: 1 }
            }],
            ['lastUncountedKind 為數值', (j) => {
                j.ranges[0].lastUncountedKind = 5
            }],
            ['範圍為 null', (j) => {
                j.ranges[2] = null
            }],
            ['範圍為字串', (j) => {
                j.ranges[2] = 'x'
            }],
            ['ranges 為空', (j) => {
                j.ranges = []
            }],
            ['ranges 非陣列', (j) => {
                j.ranges = {}
            }],
            ['v 非 1', (j) => {
                j.v = 2
            }],
            ['interval 未知', (j) => {
                j.interval = 'zzz'
            }],
            ['interval 為原型鏈名', (j) => {
                j.interval = 'constructor'
            }],
            ['interval 非字串', (j) => {
                j.interval = ['4hr']
            }],
            ['interval 與呼叫端不符', (j) => {
                j.interval = '1hr'
            }],
            ['timeZone 無效', (j) => {
                j.timeZone = 'Bad/Zone'
            }],
            ['timeZone 與呼叫端不符', (j) => {
                j.timeZone = 'Asia/Taipei'
            }],
            ['timeZone 缺', (j) => {
                delete j.timeZone
            }],
        ]
        for (let [nm, f] of bad) {
            let j = JSON.parse(JSON.stringify(j0))
            f(j)
            fs.writeFileSync(fp, JSON.stringify(j), 'utf8')
            let t = performance.now()
            assert.strictEqual(parseGapFile(fp, meta), null, nm)
            let gsb = openGapStore(fd, meta)
            assert.strictEqual(gsb.invalid(), true, nm)
            assert.strictEqual(gsb.has('20260125000000'), false, nm)
            assert.deepStrictEqual(gsb.list(), [], nm)
            assert.ok(performance.now() - t < 1000, nm)
        }
        //不給 expect(readGaps 之讀法)時, 檔頭之週期鍵與時區不必與呼叫端相符, 本身合法者照讀; 給了而不符者為無紀錄
        fs.writeFileSync(fp, JSON.stringify(j0), 'utf8')
        assert.notStrictEqual(parseGapFile(fp), null)
        assert.notStrictEqual(parseGapFile(fp, meta), null)
        assert.strictEqual(parseGapFile(fp, { interval: '4hr', timeZone: 'Asia/Taipei' }), null)
        assert.strictEqual(parseGapFile(fp, { interval: '1hr', timeZone: 'UTC' }), null)
        //檔案超過 64MiB(內容合法而以空白填充)者不讀
        fs.writeFileSync(fp, JSON.stringify(j0) + ' '.repeat(64 * 1024 * 1024), 'utf8')
        assert.strictEqual(parseGapFile(fp, meta), null)
        assert.strictEqual(openGapStore(fd, meta).invalid(), true)
        //格式合法者照讀(對照; 未超過上限)
        fs.writeFileSync(fp, JSON.stringify(j0) + ' '.repeat(1000), 'utf8')
        assert.deepStrictEqual(openGapStore(fd, meta).barsOf('20260125000000'), good)
        //不同 tag 解析為同一時刻(夏令時間春進之不存在時刻: 02:00 與 03:00 皆為 07:00Z)而含同一根者視為重疊
        let fd2 = path.resolve(fdRoot, 'U8dst')
        fs.mkdirSync(fd2, { recursive: true })
        let rg = { from: '2026-03-08T03:00:00', to: '2026-03-08T03:00:00', n: 1, ...JSON.parse(JSON.stringify(j0.ranges[0])) }
        rg.from = '2026-03-08T03:00:00'
        rg.to = '2026-03-08T03:00:00'
        let jd = { v: 1, interval: '1hr', timeZone: 'America/New_York', ranges: [{ ...rg, tag: '20260308030000' }] }
        fs.writeFileSync(fpGapsOf(fd2), JSON.stringify(jd), 'utf8')
        assert.notStrictEqual(parseGapFile(fpGapsOf(fd2), { interval: '1hr', timeZone: 'America/New_York' }), null)
        jd.ranges.push({ ...rg, tag: '20260308020000' })
        fs.writeFileSync(fpGapsOf(fd2), JSON.stringify(jd), 'utf8')
        assert.strictEqual(parseGapFile(fpGapsOf(fd2), { interval: '1hr', timeZone: 'America/New_York' }), null)
    })

    it('U9 紀錄檔為原子寫入: 先寫暫存檔再改名, 不直接寫紀錄檔之路徑; 暫存檔名不符紀錄檔與分段之格式; 用畢不留暫存檔; 寫入失敗不留暫存檔且拋出', function() {
        //W15: 寫暫存檔再改名, 讀者不會讀到寫一半之檔
        let fd = path.resolve(fdRoot, 'U9')
        fs.mkdirSync(fd, { recursive: true })
        let fp = fpGapsOf(fd)
        let writes = []
        let renames = []
        let wf = fs.writeFileSync
        let rn = fs.renameSync
        fs.writeFileSync = (p, ...args) => {
            writes.push(path.basename(String(p)))
            return wf(p, ...args)
        }
        fs.renameSync = (a, b) => {
            renames.push([path.basename(String(a)), path.basename(String(b))])
            return rn(a, b)
        }
        try {
            writeGaps(fd, { interval: '4hr', timeZone: 'UTC' }, { 20260125000000: new Map([[Date.parse('2026-01-25T08:00:00Z'), recOf({})]]) })
        }
        finally {
            fs.writeFileSync = wf
            fs.renameSync = rn
        }
        assert.deepStrictEqual(writes, [`_gaps.json.${process.pid}.tmp`])
        assert.deepStrictEqual(renames, [[`_gaps.json.${process.pid}.tmp`, '_gaps.json']])
        assert.ok(!/\.csv$/.test(writes[0]) && !/^\d{14}/.test(writes[0]))
        assert.deepStrictEqual(fs.readdirSync(fd), ['_gaps.json'])
        //改名失敗: 暫存檔被清除, 原紀錄檔不動, 錯誤外拋
        let before = fs.readFileSync(fp, 'utf8')
        let gs = openGapStore(fd, { interval: '4hr', timeZone: 'UTC' })
        gs.barsOf('20260125000000').get(Date.parse('2026-01-25T08:00:00Z')).validCount = 2
        gs.touch('20260125000000')
        fs.renameSync = () => {
            throw new Error('rename failed')
        }
        try {
            assert.throws(() => gs.save(), (err) => err.message === 'rename failed')
        }
        finally {
            fs.renameSync = rn
        }
        assert.deepStrictEqual(fs.readdirSync(fd), ['_gaps.json'])
        assert.strictEqual(fs.readFileSync(fp, 'utf8'), before)
    })

    it('U10 紀錄物件: 檔只讀一次(不存在時不讀)、未更動不寫、只重建更動之分段、不展開未用之分段、重置只刪指定分段', function() {
        //W15: 每次執行讀一次、有變動才覆寫; 手動重置只刪期間內各段之範圍
        let fd = path.resolve(fdRoot, 'U10')
        let meta = { interval: '4hr', timeZone: 'UTC' }
        let fp = fpGapsOf(fd)
        fs.mkdirSync(fd, { recursive: true })
        //不存在: 不讀、不建檔
        let nRead = countReads(fp, () => {
            let g0 = openGapStore(fd, meta)
            assert.strictEqual(g0.invalid(), false)
            assert.strictEqual(g0.has('20260125000000'), false)
            assert.strictEqual(g0.summary('20260125000000'), null)
            assert.deepStrictEqual(g0.list(), [])
            assert.strictEqual(g0.save(), false)
        })
        assert.strictEqual(nRead, 0)
        assert.strictEqual(fs.existsSync(fp), false)
        //三個分段: A(兩個暫無數據之範圍)、B(三根已標註)、C(一根暫無數據)
        let oA = Date.parse('2026-01-25T00:00:00Z')
        let oB = Date.parse('2026-02-02T00:00:00Z')
        let oC = Date.parse('2026-02-10T00:00:00Z')
        let tagA = '20260125000000'
        let tagB = '20260202000000'
        let tagC = '20260210000000'
        writeGaps(fd, meta, {
            [tagA]: new Map([[oA + 4 * H, recOf({ validCount: 2 })], [oA + 12 * H, recOf({ validCount: 5 })]]),
            [tagB]: new Map([0, 1, 2].map((i) => [oB + 4 * H + i * 4 * H, recOf({ state: 'nodata', validCount: 3, markedAt: T })])),
            [tagC]: new Map([[oC, recOf({})]]),
        })
        let text0 = fs.readFileSync(fp, 'utf8')
        let mt0 = fs.statSync(fp).mtimeMs
        //檔只讀一次: 各種操作(has、summary、recAt、list、barsOf、touch、save)合計只讀 1 次
        let nRead2 = countReads(fp, () => {
            let g = openGapStore(fd, meta)
            assert.deepStrictEqual([tagA, tagB, tagC, '20260301000000'].map((t) => g.has(t)), [true, true, true, false])
            assert.deepStrictEqual(g.summary(tagA), { pending: true, noData: 0 })
            assert.deepStrictEqual(g.summary(tagB), { pending: false, noData: 3 })
            assert.deepStrictEqual(g.summary(tagC), { pending: true, noData: 0 })
            assert.strictEqual(g.summary('20260301000000'), null)
            //recAt: 不展開即可取得(時間欄為毫秒), 範圍外為 undefined
            assert.deepStrictEqual(g.recAt(tagB, oB + 8 * H), recOf({ state: 'nodata', validCount: 3, markedAt: T }))
            assert.strictEqual(g.recAt(tagB, oB + 16 * H), undefined)
            assert.strictEqual(g.recAt(tagB, oB), undefined)
            assert.strictEqual(g.recAt(tagB, oB + 8 * H + 1), undefined)
            assert.strictEqual(g.recAt('20260301000000', oB), undefined)
            assert.deepStrictEqual(g.list(new Set([tagB])).map((v) => [v.tag, v.n, v.state]), [[tagB, 3, 'nodata']])
            assert.deepStrictEqual(g.list().map((v) => [v.tag, v.from]), [[tagA, '2026-01-25T04:00:00'], [tagA, '2026-01-25T12:00:00'], [tagB, '2026-02-02T04:00:00'], [tagC, '2026-02-10T00:00:00']])
            //展開 A 但未更動(不 touch): 不寫
            let bars = g.barsOf(tagA)
            assert.strictEqual(bars.size, 2)
            assert.strictEqual(g.save(), false)
        })
        assert.strictEqual(nRead2, 1)
        assert.strictEqual(fs.readFileSync(fp, 'utf8'), text0)
        assert.strictEqual(fs.statSync(fp).mtimeMs, mt0)
        //更動 A 之一根: 只有 A 之範圍重建, B 與 C 之列逐字相同
        let g1 = openGapStore(fd, meta)
        g1.barsOf(tagA).get(oA + 4 * H).validCount = 3
        g1.touch(tagA)
        assert.strictEqual(g1.save(), true)
        let l0 = text0.split('\n')
        let l1 = fs.readFileSync(fp, 'utf8').split('\n')
        assert.strictEqual(l1.length, l0.length)
        assert.deepStrictEqual(l1.filter((v, i) => v !== l0[i]).length, 1)
        assert.strictEqual(JSON.parse(l1.find((v) => v.indexOf('"2026-01-25T04:00:00"') >= 0).trim().replace(/,$/, '')).validCount, 3)
        for (let k of [2, 3]) {
            assert.strictEqual(l1[l1.length - 1 - k], l0[l0.length - 1 - k])
        }
        //重置: 只刪指定分段(含不存在者不計), 其餘不動; 回傳被刪之分段數
        let g2 = openGapStore(fd, meta)
        assert.strictEqual(g2.resetTags(new Set([tagA, '20260301000000'])), 1)
        assert.strictEqual(g2.has(tagA), false)
        assert.strictEqual(g2.save(), true)
        let j = readJson(fp)
        assert.deepStrictEqual(j.ranges.map((v) => v.tag), [tagB, tagC])
        //再重置不存在者: 不改, 不寫
        let g3 = openGapStore(fd, meta)
        assert.strictEqual(g3.resetTags(new Set([tagA])), 0)
        assert.strictEqual(g3.save(), false)
        //全數刪除: 刪檔
        assert.strictEqual(g3.resetTags(new Set([tagB, tagC])), 2)
        assert.strictEqual(g3.save(), true)
        assert.strictEqual(fs.existsSync(fp), false)
    })

    it('U11 紀錄檔含大量分段(3000個, 每段3個範圍): 讀入、檢查與列出不逾數秒, 未更動之分段不重建', function() {
        //W15: 粒度改為每資料夾一個後, 小週期之資料夾含大量分段時之成本(逐範圍檢查以算術判定, 不逐根展開)
        let fd = path.resolve(fdRoot, 'U11')
        let meta = { interval: '1m', timeZone: 'UTC' }
        fs.mkdirSync(fd, { recursive: true })
        let s0 = Date.parse('2026-01-01T00:00:00Z')
        let N = 3000
        let gs = openGapStore(fd, meta)
        let tags = []
        for (let k = 0; k < N; k++) {
            let tag = ot.tz(s0 + k * H, 'UTC').format('YYYYMMDDHHmmss')
            tags.push(tag)
            let m = gs.barsOf(tag)
            for (let i = 0; i < 60; i += 20) { //每段 3 根不連續 ⇒ 3 個範圍
                m.set(s0 + k * H + i * 60000, recOf({ validCount: 1 + (k % 7) }))
            }
            gs.touch(tag)
        }
        assert.strictEqual(gs.save(), true)
        assert.ok(fs.statSync(fpGapsOf(fd)).size < 64 * 1024 * 1024)
        let t = performance.now()
        let g2 = openGapStore(fd, meta)
        let rs = g2.list()
        let ms = performance.now() - t
        assert.strictEqual(rs.length, N * 3)
        assert.strictEqual(rs[0].tag, tags[0])
        assert.strictEqual(rs[rs.length - 1].tag, tags[N - 1])
        assert.ok(ms < 10000, `讀入與列出 ${N * 3} 個範圍耗時 ${Math.round(ms)}ms`)
        //只更動一段: 其餘各列逐字相同
        let before = fs.readFileSync(fpGapsOf(fd), 'utf8').split('\n')
        g2.barsOf(tags[1500]).get(s0 + 1500 * H).validCount = 99
        g2.touch(tags[1500])
        g2.save()
        let after = fs.readFileSync(fpGapsOf(fd), 'utf8').split('\n')
        assert.strictEqual(after.length, before.length)
        assert.strictEqual(after.filter((v, i) => v !== before[i]).length, 1)
    })

    it('U12 日光節約之時區(直接下載)跨回撥之分段: 分段實際起訖比名目長1小時, 其末端之根之範圍仍為合格; 超出2小時餘裕者不合格', function() {
        //W15: 有日光節約之時區之直接下載(如 1hr)為允許之取得方式, 分段起訖為線性之牆鐘字串, 跨回撥者實際為 49 小時(名目 48)
        let tz = 'Europe/London'
        let meta = { interval: '1hr', timeZone: tz }
        let fd = path.resolve(fdRoot, 'U12')
        let tag = '20261024000000' //2026-10-24 00:00(BST)起之分段, 其間 BST 於 10-25 02:00 回撥為 GMT
        let s0 = ot.tz('2026-10-24T00:00:00', tz).valueOf()
        //同 saveNative 之算法取得該分段之實際請求起訖
        let vt = ot.tz('2026-10-24T00:00:00', tz)
        let tsEnd = vt.add(48, 'hour').format('YYYY-MM-DDTHH:mm:ss')
        let eMs = ot.tz(ot.tz(tsEnd, tz).add(-1, 'second').format('YYYY-MM-DDTHH:mm:ss'), tz).valueOf()
        assert.strictEqual((eMs + 1000 - s0) / H, 49)
        let roots = gridOpens(s0, eMs, '1hr')
        assert.strictEqual(roots.length, 49)
        //應有之最後一根(名目 48 小時之外、實際起訖之內)為暫無數據: 合格
        let last = roots[roots.length - 1]
        assert.ok(last > s0 + 48 * H - 1000)
        let gs = writeGaps(fd, meta, { [tag]: new Map([[roots[0], recOf({})], [last, recOf({})]]) })
        assert.strictEqual(gs.invalid(), false)
        let gs2 = openGapStore(fd, meta)
        assert.strictEqual(gs2.invalid(), false)
        assert.deepStrictEqual(gs2.barsOf(tag), new Map([[roots[0], recOf({})], [last, recOf({})]]))
        //超出名目長度加 2 小時者不合格(讀檔時不合格)
        let fdc = path.resolve(fdRoot, 'U12c')
        fs.mkdirSync(fdc, { recursive: true })
        let j = readJson(fpGapsOf(path.resolve(fdRoot, 'U12')))
        let far = s0 + 51 * H
        let farRoot = gridOpens(far, far + H, '1hr')[0]
        j.ranges = [{ ...j.ranges[0], from: ot.tz(farRoot, tz).format('YYYY-MM-DDTHH:mm:ss'), to: ot.tz(farRoot, tz).format('YYYY-MM-DDTHH:mm:ss'), n: 1 }]
        fs.writeFileSync(fpGapsOf(fdc), JSON.stringify(j), 'utf8')
        assert.strictEqual(parseGapFile(fpGapsOf(fdc), meta), null)
    })

    it('U13 以大量空物件灌滿之巨檔(未超過檔案大小上限)於 JSON.parse 前即不合格(不建出數百萬個物件)', function() {
        //W15: 讀取時不拋錯、不耗盡記憶體
        let fd = path.resolve(fdRoot, 'U13')
        fs.mkdirSync(fd, { recursive: true })
        let fp = fpGapsOf(fd)
        let meta = { interval: '4hr', timeZone: 'UTC' }
        let head = '{"v":1,"interval":"4hr","timeZone":"UTC","ranges":['
        fs.writeFileSync(fp, `${head}${'{},'.repeat(2000000)}{}]}`, 'utf8')
        assert.ok(fs.statSync(fp).size < 64 * 1024 * 1024)
        let parse = JSON.parse
        let nParse = 0
        JSON.parse = (...a) => {
            nParse++
            return parse(...a)
        }
        let r = null
        try {
            r = parseGapFile(fp, meta)
        }
        finally {
            JSON.parse = parse
        }
        assert.strictEqual(r, null)
        assert.strictEqual(nParse, 0)
        assert.strictEqual(openGapStore(fd, meta).invalid(), true)
        //對照: 以空白填充至相近大小(大括號少)者照常解析
        let good = new Map([[Date.parse('2026-01-25T08:00:00Z'), recOf({})]])
        writeGaps(path.resolve(fdRoot, 'U13b'), meta, { 20260125000000: good })
        let fpb = fpGapsOf(path.resolve(fdRoot, 'U13b'))
        fs.writeFileSync(fpb, fs.readFileSync(fpb, 'utf8') + ' '.repeat(6000000), 'utf8')
        assert.deepStrictEqual(openGapStore(path.resolve(fdRoot, 'U13b'), meta).barsOf('20260125000000'), good)
    })

    describe('aggregateData 之成因', function() {

        //6hr 由 2hr 合併(台北): 基底每段 4 天; dayStart 為 6 天前 ⇒ 基底 j0(第0~4天)、j1(第4~8天, 最新)
        let tz = 'Asia/Taipei'
        let today = ot.tz(Date.now(), tz).format('YYYY-MM-DD')
        let dayStart = ot.tz(`${today}T00:00:00`, tz).add(-6, 'day').format('YYYY-MM-DD')
        let plan = getIntervalPlan('6hr', { timeZone: tz, dayStart })
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let b = 2 * H
        let fmt = (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')
        let tagOf = (ms) => ot.tz(ms, tz).format('YYYYMMDDHHmmss')
        let tag0 = tagOf(t0)
        let tag1 = tagOf(t0 + 4 * D)
        let metaB = { interval: '2hr', timeZone: tz }
        //row, 第 i 根基底(自 t0 起)之列, 各欄逐筆相異
        let row = (i) => [fmt(t0 + i * b), `${i}.1`, `${i}.9`, `${i}.0`, `${i}.5`, `${i}.01`, fmt(t0 + (i + 1) * b - 1000), `${i}.02`, `${i + 3}`, `${i}.03`, `${i}.04`].join(', ')
        //fdOf, 基底與合併之資料夾(合併之資料夾名由呼叫端給定, aggregateData 不依其名)
        let fdOf = (name) => ({ fdBase: path.resolve(fdRoot, name, 'price', plan.baseKey), fdAgg: path.resolve(fdRoot, name, 'price', '6hr_agg') })
        //writeBase, 寫基底分段 j 之已收棒加寬限之各根(skip 內者缺), 修改時間為現在(已定稿)
        let writeBase = (fdBase, j, skip = []) => {
            let rows = []
            let n = Math.min(48, Math.floor((Date.now() - 60000 - (t0 + j * 4 * D)) / b))
            for (let i = 0; i < n; i++) {
                let k = j * 48 + i
                if (skip.indexOf(k) < 0) {
                    rows.push(row(k))
                }
            }
            fs.writeFileSync(`${fdBase}/${tagOf(t0 + j * 4 * D)}.csv`, rows.join('\n'), 'utf8')
        }
        let run = (name, failedBase, extra = {}) => {
            let { fdBase, fdAgg } = fdOf(name)
            return aggregateData({ fdBase, fdAgg, plan, timeZone: tz, dayStart, timeGrace: 60000, failedBase, ...extra })
        }
        let closed = (r) => r.missing.filter((v) => v.reason !== 'open')

        it('C1 基底第一段請求失敗而無資料: 其目標根列入 missing(cause unobserved), 不當成上市前; 未列為失敗者照舊不列', function() {
            //W16: 修正 —— 基底之段未問到時, 其目標根即使早於最早一根資料亦列入(cause 'unobserved')
            let { fdBase } = fdOf('C1')
            fs.mkdirSync(fdBase, { recursive: true })
            writeBase(fdBase, 1)
            let r = run('C1', [tag0])
            let lead = closed(r).filter((v) => v.time < fmt(t0 + 4 * D))
            let expTimes = []
            for (let o = t0; o < t0 + 4 * D; o += 6 * H) {
                expTimes.push(fmt(o))
            }
            assert.deepStrictEqual(lead.map((v) => v.time), expTimes)
            assert.deepStrictEqual(lead[0], { time: fmt(t0), have: 0, need: 3, reason: 'gap', cause: 'unobserved', causes: { pending: 0, nodata: 0, unobserved: 3, unknown: 0 } })
            assert.deepStrictEqual(closed(r).filter((v) => v.time >= fmt(t0 + 4 * D)), [])
            //未列為本次失敗(例: 上市前或尚未嘗試): 早於最早一根資料者不列(同既有)
            fs.rmSync(fdOf('C1').fdAgg, { recursive: true })
            assert.deepStrictEqual(closed(run('C1', [])), [])
        })

        it('C2 上市前之暫無數據(有紀錄而早於最早一根資料, 本次未失敗)不列; 其分段本次請求失敗(錯誤回應為有效觀察而有紀錄)者列入(cause pending)', function() {
            //W16: 上市前之目標根照舊不列(可由 gaps 查得); 修正 —— 缺之基底根所在之分段本次失敗者列入
            let { fdBase } = fdOf('C2')
            fs.mkdirSync(fdBase, { recursive: true })
            writeBase(fdBase, 1)
            let bars = new Map()
            for (let i = 0; i < 48; i++) {
                bars.set(t0 + i * b, recOf({}))
            }
            writeGaps(fdBase, metaB, { [tag0]: bars })
            assert.deepStrictEqual(closed(run('C2', [])), [])
            fs.rmSync(fdOf('C2').fdAgg, { recursive: true })
            let r = closed(run('C2', [tag0]))
            assert.strictEqual(r.length, 16)
            assert.deepStrictEqual(r[0], { time: fmt(t0), have: 0, need: 3, reason: 'gap', cause: 'pending', causes: { pending: 3, nodata: 0, unobserved: 0, unknown: 0 }, validCount: 1, firstValid: new Date(T).toISOString() })
        })

        it('C4 缺之基底根之成因全為 unknown(無紀錄、本次未失敗)時不附成因欄; 含其他成因時才附', function() {
            //W16: 同 1.0.61(例: timeBudget 留待下次之基底段、分段檔殘缺)
            let { fdBase } = fdOf('C4')
            fs.mkdirSync(fdBase, { recursive: true })
            writeBase(fdBase, 0)
            writeBase(fdBase, 1, [48, 49, 52])
            writeGaps(fdBase, metaB, { [tag1]: new Map([[t0 + 52 * b, recOf({ state: 'nodata', validCount: 3, markedAt: T })]]) })
            assert.deepStrictEqual(closed(run('C4', [])), [
                { time: fmt(t0 + 48 * b), have: 1, need: 3, reason: 'gap' },
                { time: fmt(t0 + 51 * b), have: 2, need: 3, reason: 'gap', cause: 'nodata', causes: { pending: 0, nodata: 1, unobserved: 0, unknown: 0 } },
            ])
        })

        it('C5 基底資料夾之紀錄檔損毀(firstValid 非時刻、n 過大、整檔非 JSON)時不拋錯, 整檔視為無紀錄', function() {
            //W15: 不合格之紀錄檔整檔視為無紀錄
            let { fdBase } = fdOf('C5')
            fs.mkdirSync(fdBase, { recursive: true })
            writeBase(fdBase, 0)
            writeBase(fdBase, 1, [48])
            let fp = fpGapsOf(fdBase)
            writeGaps(fdBase, metaB, { [tag1]: new Map([[t0 + 48 * b, recOf({})]]) })
            let j = readJson(fp)
            //對照: 合格者附成因
            assert.deepStrictEqual(closed(run('C5', [])), [{ time: fmt(t0 + 48 * b), have: 2, need: 3, reason: 'gap', cause: 'pending', causes: { pending: 1, nodata: 0, unobserved: 0, unknown: 0 }, validCount: 1, firstValid: new Date(T).toISOString() }])
            j.ranges[0].firstValid = 'garbage'
            fs.writeFileSync(fp, JSON.stringify(j), 'utf8')
            assert.deepStrictEqual(closed(run('C5', [])), [{ time: fmt(t0 + 48 * b), have: 2, need: 3, reason: 'gap' }])
            j.ranges[0].firstValid = new Date(T).toISOString()
            j.ranges[0].n = 3000000
            fs.writeFileSync(fp, JSON.stringify(j), 'utf8')
            assert.deepStrictEqual(closed(run('C5', [])), [{ time: fmt(t0 + 48 * b), have: 2, need: 3, reason: 'gap' }])
            fs.writeFileSync(fp, '{"v":1,', 'utf8')
            assert.deepStrictEqual(closed(run('C5', [])), [{ time: fmt(t0 + 48 * b), have: 2, need: 3, reason: 'gap' }])
        })

        it('C6 基底資料夾之紀錄: 只讀一次(給了 gapStore 者不重讀; 未給者於需要時才讀, 且無缺根時不讀)', function() {
            //W15: 每次執行讀一次; saveData 於合併時把已讀入之紀錄交給 aggregateData
            let { fdBase } = fdOf('C6')
            fs.mkdirSync(fdBase, { recursive: true })
            writeBase(fdBase, 0)
            writeBase(fdBase, 1, [48])
            writeGaps(fdBase, metaB, { [tag1]: new Map([[t0 + 48 * b, recOf({})]]) })
            let fp = fpGapsOf(fdBase)
            let gs = openGapStore(fdBase, metaB)
            let n1 = countReads(fp, () => {
                run('C6', [], { gapStore: gs })
            })
            assert.strictEqual(n1, 0)
            fs.rmSync(fdOf('C6').fdAgg, { recursive: true })
            let n2 = countReads(fp, () => {
                run('C6', [])
            })
            assert.strictEqual(n2, 1)
            //無缺根(基底齊全)時不讀紀錄檔
            let { fdBase: fdBase2 } = fdOf('C6b')
            fs.mkdirSync(fdBase2, { recursive: true })
            writeBase(fdBase2, 0)
            writeBase(fdBase2, 1)
            writeGaps(fdBase2, metaB, { [tag1]: new Map([[t0 + 60 * b, recOf({})]]) })
            let n3 = countReads(fpGapsOf(fdBase2), () => {
                run('C6b', [])
            })
            assert.strictEqual(n3, 0)
        })

        it('C3 成因與最嚴者(unobserved > unknown > pending > nodata)、各成因之根數、暫無數據之最少次數與最早首次時刻', function() {
            //W16: aggregate.missing 之 gap 增 cause、causes; 含暫無數據者附 validCount(最小)與 firstValid(最早)
            let { fdBase } = fdOf('C3')
            fs.mkdirSync(fdBase, { recursive: true })
            writeBase(fdBase, 0)
            //j1 之第一天: 目標 m0(基底 48,49,50)、m1(51,52,53)、m2(54,55,56)
            writeBase(fdBase, 1, [48, 49, 50, 52, 54, 55])
            let o = (k) => t0 + k * b
            writeGaps(fdBase, metaB, {
                [tag1]: new Map([
                    [o(48), recOf({ validCount: 2, firstValid: T - 10 * D })],
                    [o(49), recOf({ validCount: 1, firstValid: T - 3 * D, lastValid: T - 3 * D })],
                    [o(50), recOf({ state: 'nodata', validCount: 3, markedAt: T })],
                    [o(52), recOf({ state: 'nodata', validCount: 4, markedAt: T })],
                    [o(54), recOf({ validCount: 5, firstValid: T - 20 * D })],
                ]),
            })
            let r = closed(run('C3', []))
            assert.deepStrictEqual(r, [
                { time: fmt(o(48)), have: 0, need: 3, reason: 'gap', cause: 'pending', causes: { pending: 2, nodata: 1, unobserved: 0, unknown: 0 }, validCount: 1, firstValid: new Date(T - 10 * D).toISOString() },
                { time: fmt(o(51)), have: 2, need: 3, reason: 'gap', cause: 'nodata', causes: { pending: 0, nodata: 1, unobserved: 0, unknown: 0 } },
                { time: fmt(o(54)), have: 1, need: 3, reason: 'gap', cause: 'unknown', causes: { pending: 1, nodata: 0, unobserved: 0, unknown: 1 }, validCount: 5, firstValid: new Date(T - 20 * D).toISOString() },
            ])
            //j1 本次請求失敗: 無紀錄之缺根為 unobserved(最嚴)
            r = closed(run('C3', [tag1]))
            assert.deepStrictEqual(r[2].cause, 'unobserved')
            assert.deepStrictEqual(r[2].causes, { pending: 1, nodata: 0, unobserved: 1, unknown: 0 })
            assert.deepStrictEqual(r[0].cause, 'pending')
        })

    })

})
