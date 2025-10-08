import axios from 'axios'
import ot from 'dayjs'
import get from 'lodash-es/get.js'
import map from 'lodash-es/map.js'
import size from 'lodash-es/size.js'
import join from 'lodash-es/join.js'
import iseobj from 'wsemi/src/iseobj.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import delay from 'wsemi/src/delay.mjs'


/**
 * 下載指定時間區間內的 K 線數據(Kline)，並可選擇轉為 CSV 格式輸出。
 *
 * @async
 * @function downloadData
 * @param {string} endpoint - API 端點 URL，例如 'https://api.binance.com/api/v3/klines'
 * @param {string} symbol - 幣種對，例如 'BTCUSDT'
 * @param {string} timeStart - 開始時間，格式為 'YYYY-MM-DDTHH:mm:ss'
 * @param {string} timeEnd - 結束時間，格式為 'YYYY-MM-DDTHH:mm:ss'
 * @param {string} interval - K 線資料間隔時間，例如 '1m', '5m', '1h' 等
 * @param {Object} [opt={}] - 可選參數設定
 * @param {Object} [opt.proxy] - 代理伺服器設定，符合 axios proxy 格式 `{ protocol, host, port }`
 * @param {boolean} [opt.useConvertToCsv=true] - 是否將結果轉換為 CSV 字串格式
 * @returns {Promise} 回傳Promise，resolve回傳解析後的 K 線資料陣列，或轉為 CSV 字串（依 useConvertToCsv 而定），reject回傳錯誤訊息
 * @example
 *
 * import WDwdataBinace from './src/WDwdataBinace.mjs'
 *
 * function test() {
 *
 *     //wdd
 *     let wdd = WDwdataBinace()
 *
 *     //BTC
 *     let name = 'BTC'
 *
 *     //price
 *     let type = 'price'
 *
 *     //幣安API的klines
 *     let endpoint = 'https://api.binance.com/api/v3/klines'
 *
 *     //BTCUSDT交易對
 *     let symbol = 'BTCUSDT'
 *
 *     //p
 *     let p = wdd.syncData(name, type, endpoint, symbol, { useShowLog: true })
 *
 *     //run
 *     p.run()
 *
 * }
 * test()
 * //get BTC price ts[2020-01-02T11:00:00] -> te[2020-01-02T11:59:59] downloading...
 * //get BTC price ts[2020-01-02T11:00:00] -> te[2020-01-02T11:59:59] finish
 * //get BTC price ts[2020-01-02T12:00:00] -> te[2020-01-02T12:59:59] downloading...
 * //get BTC price ts[2020-01-02T12:00:00] -> te[2020-01-02T12:59:59] finish
 * //get BTC price ts[2020-01-02T13:00:00] -> te[2020-01-02T13:59:59] downloading...
 * //continuing...
 *
 */
let downloadData = async (endpoint, symbol, timeStart, timeEnd, interval, opt = {}) => {

    //proxy
    let proxy = get(opt, 'proxy')
    if (!iseobj(proxy)) {
        proxy = {}
    }

    //useConvertToCsv
    let useConvertToCsv = get(opt, 'useConvertToCsv')
    if (!isbol(useConvertToCsv)) {
        useConvertToCsv = true
    }

    //limit, 0.5d=0.5*24*60=720筆分鐘數據/每半天
    let limit = 1000 //每次請求的資料點數量, 最高1000

    //startTime
    let startTime = ot(timeStart, 'YYYY-MM-DDTHH:mm:ss').valueOf()
    // console.log('timeStart', timeStart)
    // console.log('startTime', startTime)

    //endTime
    let endTime = ot(timeEnd, 'YYYY-MM-DDTHH:mm:ss').valueOf()
    // console.log('timeEnd', timeEnd)
    // console.log('endTime', endTime)

    // //url
    // let url = `${endpoint}?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`
    // // console.log('url', url)

    //rs
    let url = ''
    let rs = []
    try {

        //get
        let response = await axios.get(endpoint, {
            params: {
                symbol,
                startTime,
                endTime,
                interval,
                limit,
            },
            // proxy,
        })
        let res = response.data

        //url
        url = get(response, 'request.res.responseUrl', '')
        // console.log('url',url)

        //delay
        await delay(100) //幣安limit: 2400 requests per minute

        //timeDataMax
        let timeDataMax = ot().format('YYYY-MM-DDTHH:mm:ss')

        //parse
        rs = map(res, (v) => {

            //timeDataStart
            let timeDataStart = ot(v[0]).format('YYYY-MM-DDTHH:mm:ss')
            // if (timeDataStart > timeDataMax) {
            //     timeDataStart = timeDataMax
            // }

            //timeDataEnd
            let timeDataEnd = ot(v[6]).format('YYYY-MM-DDTHH:mm:ss')
            if (timeDataEnd > timeDataMax) {
                timeDataEnd = timeDataMax
            }

            return [
                timeDataStart, //開始時間
                v[1], // 開盤價
                v[2], // 最高價
                v[3], // 最低價
                v[4], // 收盤價
                v[5], // 成交量, index無此數據
                timeDataEnd, //結束時間
                v[7], // 成交金額, index無此數據
                v[8], // 成交筆數, index無此數據
                v[9], // 主動買入成交量, index無此數據
                v[10], // 主動買入成交金額, index無此數據
                // v[11] // 忽略此欄位, index無此數據
            ]
        })

    }
    catch (err) {
        console.log(`can not get k-data for symbol[${symbol}]`, err)
    }

    //check
    if (size(rs) === 0) {
        console.log('url', url)
        console.log(`invalid k-data for symbol[${symbol}]`)
        return
    }

    //useConvertToCsv
    if (useConvertToCsv) {
        let cd = map(rs, (v) => {
            return join(v, ', ')
        })
        let cs = join(cd, '\n')
        // console.log('cs', cs)
        rs = cs
    }

    return rs
}


export default downloadData
