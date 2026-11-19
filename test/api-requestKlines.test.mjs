import assert from 'assert'
import http from 'http'
import timers from '../src/timers.mjs'
import { getFetchOpts, classifyResult, requestKlines } from '../src/requestKlines.mjs'
import { install, uninstall } from './tools/fakeClock.mjs'
import downloadData from '../src/downloadData.mjs'


//規格: sgud/rule/rulebook.md W13(重試、間隔、Retry-After與上限、逾時、418與超限時停止)、W14(請求結果之分類)

//script, 假交易所依序回應之腳本; 每個元素 { status, body, headers, hang, destroy }, 用完後回 200 []
let script = []
let reqs = [] //收到請求之路徑與查詢字串
let hung = [] //未回應之請求(逾時之案), 於 afterEach 結束
let waits = [] //重試前之等待(注入之計時器只記錄毫秒數而不真的等待)
let sleepReal = timers.sleep
let server = null
let port = 0
let ep = () => `http://127.0.0.1:${port}/api/v3/klines`

//fo, 預設之選項
let fo = () => getFetchOpts({})

let params = { symbol: 'TESTUSDT', startTime: 1, endTime: 2, interval: '4h', limit: 1000 }


describe('api-requestKlines', function() {

    before(async function() {
        timers.sleep = async (ms) => {
            waits.push(ms)
        }
        server = http.createServer((req, res) => {
            reqs.push(req.url)
            let s = script.length > 0 ? script.shift() : { status: 200, body: [] }
            if (s.hang) {
                hung.push(res)
                return
            }
            if (s.destroy) {
                req.socket.destroy()
                return
            }
            let body = typeof s.body === 'string' ? s.body : JSON.stringify(s.body)
            res.writeHead(s.status, { 'Content-Type': typeof s.body === 'string' ? 'text/html' : 'application/json', ...(s.headers || {}) })
            res.end(body)
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        port = server.address().port
    })

    beforeEach(function() {
        script = []
        reqs = []
        waits = []
    })

    afterEach(function() {
        for (let res of hung) {
            res.destroy()
        }
        hung = []
    })

    after(async function() {
        timers.sleep = sleepReal
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    })

    it('K1 請求成功時只送1次、不等待(不多送請求)', async function() {
        //W13: 請求成功時不多送請求、不多等待
        script = [{ status: 200, body: [[1, '1', '2', '0', '1', '3', 2, '4', 5, '6', '7', '0']] }]
        let ctx = {}
        let r = await requestKlines(ep(), params, fo(), ctx)
        assert.strictEqual(reqs.length, 1)
        assert.deepStrictEqual(waits, [])
        assert.strictEqual(r.kind, 'ok')
        assert.strictEqual(r.attempts, 1)
        assert.strictEqual(r.data.length, 1)
        //W14: 2xx陣列(含空陣列)即確認可達
        assert.strictEqual(ctx.reachable, true)
        assert.strictEqual(ctx.halted, undefined)
    })

    it('K2 5xx 重試3次, 間隔1、3、9秒(注入之計時器), 其後成功即停', async function() {
        //W13: 第i次重試前等timeRetry*3^(i-1)
        script = [{ status: 500, body: 'e1' }, { status: 502, body: 'e2' }, { status: 503, body: 'e3' }, { status: 200, body: [] }]
        let r = await requestKlines(ep(), params, fo(), {})
        assert.strictEqual(reqs.length, 4)
        assert.deepStrictEqual(waits, [1000, 3000, 9000])
        assert.strictEqual(r.kind, 'ok')
        assert.strictEqual(r.attempts, 4)
    })

    it('K3 重試用盡仍失敗: 共1+retryTimes次, 回傳最後一次之狀態; retryTimes、timeRetry、timeRetryMax可調', async function() {
        //W13
        script = [{ status: 500, body: 'a' }, { status: 500, body: 'b' }, { status: 500, body: 'c' }, { status: 504, body: { code: -1001, msg: 'x' } }]
        let ctx = {}
        let r = await requestKlines(ep(), params, fo(), ctx)
        assert.strictEqual(reqs.length, 4)
        assert.deepStrictEqual([r.kind, r.httpStatus, r.code, r.attempts], ['httpError', 504, -1001, 4])
        assert.strictEqual(ctx.reachable, undefined)
        assert.strictEqual(ctx.halted, undefined)
        //retryTimes 0: 不重試
        script = [{ status: 500, body: 'a' }]
        reqs = []
        waits = []
        r = await requestKlines(ep(), params, getFetchOpts({ retryTimes: 0 }), {})
        assert.deepStrictEqual([reqs.length, waits, r.attempts], [1, [], 1])
        //timeRetry 500 與 retryTimes 4: 0.5、1.5、4.5、13.5 秒
        script = [{ status: 500, body: 'a' }, { status: 500, body: 'b' }, { status: 500, body: 'c' }, { status: 500, body: 'd' }, { status: 500, body: 'e' }]
        waits = []
        await requestKlines(ep(), params, getFetchOpts({ retryTimes: 4, timeRetry: 500 }), {})
        assert.deepStrictEqual(waits, [500, 1500, 4500, 13500])
        //每次等待不超過 timeRetryMax
        script = [{ status: 500, body: 'a' }, { status: 500, body: 'b' }, { status: 500, body: 'c' }, { status: 500, body: 'd' }]
        waits = []
        await requestKlines(ep(), params, getFetchOpts({ timeRetry: 30000 }), {})
        assert.deepStrictEqual(waits, [30000, 60000, 60000])
    })

    it('K4 429 有 Retry-After 且不超過上限時依之; 超過上限即停止本次執行(halted)且不再重試; 用盡重試亦停止', async function() {
        //W13: Retry-After ≤ timeRetryMax 時依之, 超過或用盡 ⇒ 本次執行停止送出後續請求
        script = [{ status: 429, body: { code: -1003 }, headers: { 'Retry-After': '7' } }, { status: 200, body: [] }]
        let ctx = {}
        let r = await requestKlines(ep(), params, fo(), ctx)
        assert.deepStrictEqual(waits, [7000])
        assert.strictEqual(r.kind, 'ok')
        assert.strictEqual(ctx.halted, undefined)
        //超過上限
        script = [{ status: 429, body: { code: -1003 }, headers: { 'Retry-After': '61' } }]
        reqs = []
        waits = []
        ctx = {}
        r = await requestKlines(ep(), params, fo(), ctx)
        assert.deepStrictEqual([reqs.length, waits, r.kind, r.attempts, ctx.halted, ctx.haltKind], [1, [], 'rateLimited', 1, true, 'rateLimited'])
        //等於上限者依之
        script = [{ status: 429, body: {}, headers: { 'Retry-After': '60' } }, { status: 200, body: [] }]
        waits = []
        ctx = {}
        await requestKlines(ep(), params, fo(), ctx)
        assert.deepStrictEqual([waits, ctx.halted], [[60000], undefined])
        //無 Retry-After 者依退避; 用盡重試後停止
        script = [{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }]
        reqs = []
        waits = []
        ctx = {}
        r = await requestKlines(ep(), params, fo(), ctx)
        assert.deepStrictEqual([reqs.length, waits, r.kind, ctx.halted, ctx.haltKind], [4, [1000, 3000, 9000], 'rateLimited', true, 'rateLimited'])
    })

    it('K5 418(IP封鎖)不重試並停止本次執行', async function() {
        //W13: 418 ⇒ 停止送出後續請求(續送會延長封鎖)
        script = [{ status: 418, body: { code: -1003 }, headers: { 'Retry-After': '1' } }]
        let ctx = {}
        let r = await requestKlines(ep(), params, fo(), ctx)
        assert.deepStrictEqual([reqs.length, waits, r.kind, r.httpStatus, r.code, ctx.halted, ctx.haltKind], [1, [], 'banned', 418, -1003, true, 'banned'])
    })

    it('K6 403、HTTP 200 而回應非陣列、連線中斷皆重試; 400 與 404 不重試', async function() {
        //W13 重試之情形; W14 分類
        script = [{ status: 403, body: '<html>waf</html>' }, { status: 200, body: '<html>challenge</html>' }, { destroy: true }, { status: 200, body: [] }]
        let r = await requestKlines(ep(), params, fo(), {})
        assert.deepStrictEqual([reqs.length, waits, r.kind], [4, [1000, 3000, 9000], 'ok'])
        script = [{ status: 400, body: { code: -1121, msg: 'Invalid symbol.' } }]
        reqs = []
        waits = []
        r = await requestKlines(ep(), params, fo(), {})
        assert.deepStrictEqual([reqs.length, waits, r.kind, r.httpStatus, r.code], [1, [], 'badRequest', 400, -1121])
        script = [{ status: 404, body: '<html>nf</html>' }]
        reqs = []
        r = await requestKlines(ep(), params, fo(), {})
        assert.deepStrictEqual([reqs.length, r.kind, r.httpStatus, r.code], [1, 'httpError', 404, null])
    })

    it('K7 逾時: 不回應之請求於timeRequest後中止(不永久卡住)並重試', async function() {
        //W13: 單一請求之逾時(自送出至收完回應)
        script = [{ hang: true }, { hang: true }]
        let t = Date.now()
        let r = await requestKlines(ep(), params, getFetchOpts({ timeRequest: 300, retryTimes: 1 }), {})
        assert.deepStrictEqual([reqs.length, waits, r.kind, r.attempts], [2, [1000], 'timeout', 2])
        //防懸置之上限(真實時鐘): 兩次逾時各 300 毫秒, 遠小於 30 秒
        assert.ok(Date.now() - t < 20000)
    })

    it('K8 連線不到(埠未監聽)為 network', async function() {
        //W14: 連線錯誤不算觀察
        let srv = http.createServer()
        await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
        let p = srv.address().port
        await new Promise((resolve) => srv.close(resolve))
        let r = await requestKlines(`http://127.0.0.1:${p}/api/v3/klines`, params, getFetchOpts({ retryTimes: 1 }), {})
        assert.deepStrictEqual([r.kind, r.httpStatus, r.code, r.attempts, waits], ['network', null, 'ECONNREFUSED', 2, [1000]])
    })

    it('K9 classifyResult 之各類', function() {
        //W14
        let res = (status, data, headers = {}) => ({ response: { status, data, headers }, err: null, aborted: false })
        assert.deepStrictEqual(classifyResult(res(200, [])), { kind: 'ok', httpStatus: 200, code: null, retryAfter: null, retry: false })
        assert.strictEqual(classifyResult(res(200, [[1], 2])).kind, 'invalidResponse')
        assert.strictEqual(classifyResult(res(200, { code: 0 })).kind, 'invalidResponse')
        assert.deepStrictEqual(classifyResult(res(429, { code: -1003 }, { 'retry-after': '5' })), { kind: 'rateLimited', httpStatus: 429, code: -1003, retryAfter: 5000, retry: true })
        assert.strictEqual(classifyResult(res(418, {})).retry, false)
        assert.deepStrictEqual(classifyResult(res(403, 'x')), { kind: 'blocked', httpStatus: 403, code: null, retryAfter: null, retry: true })
        assert.deepStrictEqual(classifyResult(res(400, { code: -1120 })), { kind: 'badRequest', httpStatus: 400, code: -1120, retryAfter: null, retry: false })
        assert.deepStrictEqual(classifyResult(res(500, { code: 'x' })), { kind: 'httpError', httpStatus: 500, code: null, retryAfter: null, retry: true })
        assert.strictEqual(classifyResult(res(451, {})).retry, false)
        assert.strictEqual(classifyResult({ response: null, err: { code: 'ECONNABORTED' }, aborted: false }).kind, 'timeout')
        assert.strictEqual(classifyResult({ response: null, err: { code: 'X' }, aborted: true }).kind, 'timeout')
        assert.deepStrictEqual(classifyResult({ response: null, err: { code: 'ECONNRESET' }, aborted: false }), { kind: 'network', httpStatus: null, code: 'ECONNRESET', retryAfter: null, retry: true })
    })

    it('K10 429 之 Retry-After 為 HTTP 日期時依其與現在之差等待(假時鐘); 無法解析者依退避', async function() {
        //W13: Retry-After(秒數或 HTTP 日期)不超過上限時依之
        let now = Date.parse('2026-03-01T00:00:00Z')
        install(now)
        try {
            script = [{ status: 429, body: {}, headers: { 'Retry-After': new Date(now + 7000).toUTCString() } }, { status: 200, body: [] }]
            let ctx = {}
            let r = await requestKlines(ep(), params, fo(), ctx)
            assert.deepStrictEqual([waits, r.kind, ctx.halted], [[7000], 'ok', undefined])
            //HTTP 日期超過上限(61秒後) ⇒ 停止
            script = [{ status: 429, body: {}, headers: { 'Retry-After': new Date(now + 61000).toUTCString() } }]
            waits = []
            ctx = {}
            r = await requestKlines(ep(), params, fo(), ctx)
            assert.deepStrictEqual([waits, r.attempts, ctx.halted], [[], 1, true])
            //無法解析 ⇒ 依退避
            script = [{ status: 429, body: {}, headers: { 'Retry-After': 'soon' } }, { status: 200, body: [] }]
            waits = []
            await requestKlines(ep(), params, fo(), {})
            assert.deepStrictEqual(waits, [1000])
        }
        finally {
            uninstall()
        }
    })

    it('K13 403(防火牆封鎖)重試用盡後停止本次執行; 重試期間轉為成功則不停止', async function() {
        //W13: 403 比照 429, 用盡重試 ⇒ 本次執行停止送出後續請求
        script = [{ status: 403, body: '<html>waf</html>' }, { status: 403, body: '<html>waf</html>' }, { status: 403, body: '<html>waf</html>' }, { status: 403, body: '<html>waf</html>' }]
        let ctx = {}
        let r = await requestKlines(ep(), params, fo(), ctx)
        assert.deepStrictEqual([reqs.length, waits, r.kind, r.httpStatus, ctx.halted, ctx.haltKind], [4, [1000, 3000, 9000], 'blocked', 403, true, 'blocked'])
        script = [{ status: 403, body: '<html>waf</html>' }, { status: 200, body: [] }]
        ctx = {}
        r = await requestKlines(ep(), params, fo(), ctx)
        assert.deepStrictEqual([r.kind, ctx.halted], ['ok', undefined])
    })


    it('K11 getFetchOpts: 預設值; undefined與null用預設; 給了而無效改用預設(不拋); 整數類接受數字字串並轉為數值', function() {
        //輸入檢測規格 K3(執行參數無效改用預設)、K7(數字字串)、K4(其後使用轉換值); 任務書: retryTimes、timeRetry、timeRetryMax、timeRequest、netFailTimes 給了而無效改用預設(不拋)
        let def = { retryTimes: 3, timeRetry: 1000, timeRetryMax: 60000, timeRequest: 30000, netFailTimes: 3 }
        assert.deepStrictEqual(getFetchOpts({}), def)
        assert.deepStrictEqual(getFetchOpts(), def)
        assert.deepStrictEqual(getFetchOpts(null), def)
        assert.deepStrictEqual(getFetchOpts({ retryTimes: null, timeRequest: undefined, netFailTimes: null }), def)
        assert.deepStrictEqual(getFetchOpts({ retryTimes: 0, timeRetry: 0, timeRetryMax: 0, timeRequest: 1, netFailTimes: 0 }), { retryTimes: 0, timeRetry: 0, timeRetryMax: 0, timeRequest: 1, netFailTimes: 0 })
        //無效 ⇒ 該鍵用預設, 其餘鍵不受影響(各鍵獨立)
        let bad = [
            ['retryTimes', -1],
            ['retryTimes', 1.5],
            ['retryTimes', 'x'],
            ['retryTimes', ''],
            ['retryTimes', '0x10'],
            ['retryTimes', Infinity],
            ['retryTimes', NaN],
            ['retryTimes', true],
            ['retryTimes', {}],
            ['retryTimes', 4294967296],
            ['timeRetry', -1],
            ['timeRetry', 2147483648],
            ['timeRetryMax', NaN],
            ['timeRetryMax', 'abc'],
            ['timeRetryMax', 2147483648],
            ['timeRequest', 0],
            ['timeRequest', '0'],
            ['timeRequest', Infinity],
            ['timeRequest', 2147483648],
            ['netFailTimes', -1],
            ['netFailTimes', '1.5'],
            ['netFailTimes', '0b11'],
        ]
        for (let [k, v] of bad) {
            let r = null
            assert.doesNotThrow(() => {
                r = getFetchOpts({ retryTimes: 1, timeRetry: 2, timeRetryMax: 3, timeRequest: 4, netFailTimes: 5, [k]: v })
            }, `${k}=${String(v)}`)
            assert.deepStrictEqual(r, { retryTimes: 1, timeRetry: 2, timeRetryMax: 3, timeRequest: 4, netFailTimes: 5, [k]: def[k] }, `${k}=${String(v)}`)
        }
        //數字字串(去頭尾空白、小數點後全為0、科學記號之整數)轉為數值
        assert.deepStrictEqual(getFetchOpts({ retryTimes: '2', timeRetry: ' 50 ', timeRetryMax: '1e3', timeRequest: '200.0', netFailTimes: '0' }), { retryTimes: 2, timeRetry: 50, timeRetryMax: 1000, timeRequest: 200, netFailTimes: 0 })
        assert.strictEqual(Object.is(getFetchOpts({ retryTimes: '-0' }).retryTimes, 0), true)
        //不改寫輸入
        let o = { retryTimes: '2' }
        getFetchOpts(o)
        assert.deepStrictEqual(o, { retryTimes: '2' })
    })

    it('K12 downloadData(公開): 重試後成功回CSV, 重試後仍失敗回undefined(回傳型別不變), 選項無效時改用預設(不reject)、數字字串轉為數值', async function() {
        //downloadData 之回傳值不變; W13 套用於 downloadData
        script = [{ status: 500, body: 'x' }, { status: 200, body: [[1700000000000, '1.5', '2.5', '0.5', '1.25', '3', 1700000000000 + 14399999, '4', 5, '6', '7', '0']] }]
        let r = await downloadData(ep(), 'TESTUSDT', '2023-11-14T00:00:00', '2023-11-15T00:00:00', '4h', { timeZone: 'UTC' })
        assert.strictEqual(r, '2023-11-14T22:13:20, 1.5, 2.5, 0.5, 1.25, 3, 2023-11-15T02:13:19, 4, 5, 6, 7')
        assert.deepStrictEqual(waits, [1000])
        script = [{ status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' }]
        let logs = []
        let log = console.log
        console.log = (...args) => {
            logs.push(args.join(' '))
        }
        try {
            r = await downloadData(ep(), 'TESTUSDT', '2023-11-14T00:00:00', '2023-11-15T00:00:00', '4h', { timeZone: 'UTC' })
        }
        finally {
            console.log = log
        }
        assert.strictEqual(r, undefined)
        assert.deepStrictEqual(logs, ['can not get k-data for symbol[TESTUSDT] kind[httpError] status[500] code[null] attempts[4]', 'url ', 'invalid k-data for symbol[TESTUSDT]'])
        //retryTimes 無效(負數、小數、Infinity、'0x10')改用預設 3 次: 仍重試 3 次(共 4 次), 不 reject
        for (let v of [-1, 1.5, Infinity, '0x10']) {
            reqs = []
            script = [{ status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' }]
            let log2 = console.log
            console.log = () => {}
            try {
                r = await downloadData(ep(), 'TESTUSDT', '2023-11-14T00:00:00', '2023-11-15T00:00:00', '4h', { timeZone: 'UTC', retryTimes: v })
            }
            finally {
                console.log = log2
            }
            assert.strictEqual(r, undefined, String(v))
            assert.strictEqual(reqs.length, 4, String(v))
        }
        //數字字串: retryTimes '1' 即 1 次重試(共 2 次)
        reqs = []
        script = [{ status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' }]
        let log3 = console.log
        console.log = () => {}
        try {
            r = await downloadData(ep(), 'TESTUSDT', '2023-11-14T00:00:00', '2023-11-15T00:00:00', '4h', { timeZone: 'UTC', retryTimes: '1' })
        }
        finally {
            console.log = log3
        }
        assert.strictEqual(r, undefined)
        assert.strictEqual(reqs.length, 2)
    })

})
