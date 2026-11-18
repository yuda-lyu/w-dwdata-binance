import assert from 'assert'
import fs from 'fs'
import path from 'path'
import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import aggregateData from '../src/aggregateData.mjs'
import { getIntervalPlan } from '../src/intervals.mjs'


ot.extend(utc)
ot.extend(timezone)


//規格出處: saveData 之 JSDoc「合併之規則」(開=首根之開、高=最高、低=最低、收=末根之收, 量、成交額、筆數、主動買入量與額=十進位精確加總, 小數位數取各根之最大者; 開始時間=首根之開始時間, 結束時間=末根之結束時間)與 aggregateData 之 missing
//各 it 之註解標明對應之規格句

let fdRoot = './test/_tmp/unit-aggregateData'
let H = 3600 * 1000


describe('unit-aggregateData', function() {

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

    it('A1 合併規則: 負值之高低比較、小數位數不一之精確加總、欄位前後空白; 基底缺一根之目標根不輸出並列為 gap', function() {
        //規格: 高=最高、低=最低(十進位比較, 含負值); 加總為十進位精確加總, 小數位數取各根之最大者; 基底各根不齊者不輸出, 記入 missing
        let tz = 'Asia/Taipei'
        let today = ot.tz(Date.now(), tz).format('YYYY-MM-DD')
        let dayStart = ot.tz(`${today}T00:00:00`, tz).add(-3, 'day').format('YYYY-MM-DD')
        let plan = getIntervalPlan('6hr', { timeZone: tz, dayStart })
        assert.strictEqual(plan.base, '2hr')
        assert.strictEqual(plan.count, 3)
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let fmt = (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')
        let fdBase = path.resolve(fdRoot, 'T', 'price', '2hr')
        let fdAgg = path.resolve(fdRoot, 'T', 'price', plan.key)
        fs.rmSync(fdRoot, { recursive: true, force: true })
        fs.mkdirSync(fdBase, { recursive: true })
        let b = 2 * H
        let row = (i, o, h, l, c, v, q, n, tb, tq, sp = ' ') => [fmt(t0 + i * b), o, h, l, c, v, fmt(t0 + (i + 1) * b - 1000), q, n, tb, tq].join(`,${sp}`)
        //高: 0.5 > 0.25 > 0.125, 低: -0.5 < -0.25 < -0.125; 若比較時不對齊小數位數(以 5、25、125 之整數比), 極值會誤取 0.125 與 -0.125
        let rows = [
            row(0, '0.1', '0.5', '-0.5', '0.2', '1.5', '0', '1', '0.1', '10'),
            row(1, '0.2', '0.25', '-0.25', '0.15', '2.25', '0', '2', '0.02', '0.5', '   '),
            row(2, '0.15', '0.125', '-0.125', '0.125', '3', '0', '3', '0.003', '0.25'),
            row(3, '5.1', '5.9', '5.0', '5.5', '11', '0', '4', '1', '1'),
            //第 4 根缺
            row(5, '6.1', '6.9', '6.0', '6.5', '12', '0', '5', '1', '1'),
        ]
        let fpB = `${fdBase}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`
        fs.writeFileSync(fpB, rows.join('\n'), 'utf8')
        let r = aggregateData({ fdBase, fdAgg, plan, timeZone: tz, dayStart, timeGrace: 60000 })
        let out = fs.readFileSync(`${fdAgg}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`, 'utf8').split('\n')
        //目標根 A(第 0~2 根): 開=0.1、高=0.5、低=-0.5、收=0.125、量=6.75、成交額=0、筆數=6、主動買入量=0.123、主動買入額=10.75
        assert.strictEqual(out[0], [fmt(t0), '0.1', '0.5', '-0.5', '0.125', '6.75', fmt(t0 + 6 * H - 1000), '0', '6', '0.123', '10.75'].join(', '))
        //目標根 B(第 3~5 根)缺第 4 根: 不輸出, missing 為 gap
        assert.strictEqual(out.length, 1)
        assert.deepStrictEqual(r.missing[0], { time: fmt(t0 + 6 * H), have: 2, need: 3, reason: 'gap' })
        assert.deepStrictEqual(r.segments, [{ tag: ot.tz(t0, tz).format('YYYYMMDDHHmmss'), n: 1 }])
        assert.strictEqual(r.timeLast, fmt(t0))
        assert.strictEqual(r.timeKeep, undefined)
    })

    it('A2 小數位數一致者之加總保留其位數(8 位), 加總為 0 者亦保留位數', function() {
        //規格: 小數位數取各根之最大者
        let tz = 'Asia/Taipei'
        let today = ot.tz(Date.now(), tz).format('YYYY-MM-DD')
        let dayStart = ot.tz(`${today}T00:00:00`, tz).add(-3, 'day').format('YYYY-MM-DD')
        let plan = getIntervalPlan('6hr', { timeZone: tz, dayStart })
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let fmt = (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')
        let fdBase = path.resolve(fdRoot, 'T2', 'price', '2hr')
        let fdAgg = path.resolve(fdRoot, 'T2', 'price', plan.key)
        fs.mkdirSync(fdBase, { recursive: true })
        let b = 2 * H
        let row = (i, v, tb) => [fmt(t0 + i * b), '1.00000000', '2.00000000', '0.50000000', '1.50000000', v, fmt(t0 + (i + 1) * b - 1000), '0.00000000', i + 1, tb, '0.00000000'].join(', ')
        let rows = [row(0, '0.00000001', '0.00000000'), row(1, '0.99999999', '0.00000000'), row(2, '12.00000000', '0.00000000')]
        fs.writeFileSync(`${fdBase}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`, rows.join('\n'), 'utf8')
        aggregateData({ fdBase, fdAgg, plan, timeZone: tz, dayStart, timeGrace: 60000 })
        let out = fs.readFileSync(`${fdAgg}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`, 'utf8').split('\n')
        assert.strictEqual(out[0], [fmt(t0), '1.00000000', '2.00000000', '0.50000000', '1.50000000', '13.00000000', fmt(t0 + 6 * H - 1000), '0.00000000', '6', '0.00000000', '0.00000000'].join(', '))
    })

    it('A3 加總為負(含小數位數不一)時保留負號與位數, 加總恰為 0 者不帶負號', function() {
        //規格: 十進位精確加總(含負值), 小數位數取各根之最大者
        let tz = 'Asia/Taipei'
        let today = ot.tz(Date.now(), tz).format('YYYY-MM-DD')
        let dayStart = ot.tz(`${today}T00:00:00`, tz).add(-3, 'day').format('YYYY-MM-DD')
        let plan = getIntervalPlan('6hr', { timeZone: tz, dayStart })
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let fmt = (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')
        let fdBase = path.resolve(fdRoot, 'T3', 'price', '2hr')
        let fdAgg = path.resolve(fdRoot, 'T3', 'price', plan.key)
        fs.mkdirSync(fdBase, { recursive: true })
        let b = 2 * H
        let row = (i, v, n, tb, tq) => [fmt(t0 + i * b), '1.0', '2.0', '0.5', '1.5', v, fmt(t0 + (i + 1) * b - 1000), '0', n, tb, tq].join(', ')
        let rows = [row(0, '-5.5', '-3', '-1', '-1'), row(1, '2', '1', '0.5', '0.25'), row(2, '1', '1', '0.5', '0.25')]
        fs.writeFileSync(`${fdBase}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`, rows.join('\n'), 'utf8')
        aggregateData({ fdBase, fdAgg, plan, timeZone: tz, dayStart, timeGrace: 60000 })
        let out = fs.readFileSync(`${fdAgg}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`, 'utf8').split('\n')
        //量: -5.5+2+1=-2.5; 筆數: -3+1+1=-1; 主動買入量: -1+0.5+0.5=0.0(不為 -0.0); 主動買入額: -1+0.25+0.25=-0.50
        assert.strictEqual(out[0], [fmt(t0), '1.0', '2.0', '0.5', '1.5', '-2.5', fmt(t0 + 6 * H - 1000), '0', '-1', '0.0', '-0.50'].join(', '))
    })

    it('A4 本輪無任何目標根可輸出而合併分段檔已存在: 不改寫該檔, timeLast 仍為檔內末列', function() {
        //規格: timeLast 與 timeKeep 為最新兩根已輸出目標根之開始時間(已輸出者含既有合併分段檔內者); 基底擷取於收棒前之目標根不輸出
        let tz = 'Asia/Taipei'
        let today = ot.tz(Date.now(), tz).format('YYYY-MM-DD')
        let dayStart = ot.tz(`${today}T00:00:00`, tz).add(-3, 'day').format('YYYY-MM-DD')
        let plan = getIntervalPlan('6hr', { timeZone: tz, dayStart })
        let t0 = ot.tz(`${dayStart}T00:00:00`, tz).valueOf()
        let fmt = (ms) => ot.tz(ms, tz).format('YYYY-MM-DDTHH:mm:ss')
        let fdBase = path.resolve(fdRoot, 'T4', 'price', '2hr')
        let fdAgg = path.resolve(fdRoot, 'T4', 'price', plan.key)
        fs.mkdirSync(fdBase, { recursive: true })
        let b = 2 * H
        let row = (i) => [fmt(t0 + i * b), '1.0', '2.0', '0.5', '1.5', `${i}.5`, fmt(t0 + (i + 1) * b - 1000), '0', i, '0', '0'].join(', ')
        let fpB = `${fdBase}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`
        let fpA = `${fdAgg}/${ot.tz(t0, tz).format('YYYYMMDDHHmmss')}.csv`
        fs.writeFileSync(fpB, [row(0), row(1), row(2)].join('\n'), 'utf8')
        let r1 = aggregateData({ fdBase, fdAgg, plan, timeZone: tz, dayStart, timeGrace: 60000 })
        assert.strictEqual(r1.timeLast, fmt(t0))
        let c1 = fs.readFileSync(fpA, 'utf8')
        //基底檔改為擷取於收棒前(修改時間為 1970 年): 第 0 根目標根不再可輸出
        fs.utimesSync(fpB, new Date(0), new Date(0))
        let r2 = aggregateData({ fdBase, fdAgg, plan, timeZone: tz, dayStart, timeGrace: 60000 })
        assert.deepStrictEqual(r2.segments, [])
        assert.strictEqual(r2.missing[0].reason, 'notFinal')
        assert.strictEqual(fs.readFileSync(fpA, 'utf8'), c1)
        assert.strictEqual(r2.timeLast, fmt(t0))
        assert.strictEqual(r2.timeKeep, undefined)
    })

})
