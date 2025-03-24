import ot from 'dayjs'
import get from 'lodash-es/get.js'
import ispint from 'wsemi/src/ispint.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import istime from 'wsemi/src/istime.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import cint from 'wsemi/src/cint.mjs'
import saveData from './saveData.mjs'


/**
 * 建立一個定時同步資料的任務，定期呼叫 saveData 以抓取與儲存幣種 K 線資料。
 * 可啟動與停止，適合作為長時間後台資料同步機制。
 *
 * @function syncData
 * @param {string} name - 資料名稱分類，例如幣種（如 BTC）
 * @param {string} type - 資料類型分類，例如 'spot', 'future' 等
 * @param {string} endpoint - 資料來源 API 的網址（如 Binance K 線 API）
 * @param {string} symbol - 幣種交易對（如 'BTCUSDT'）
 * @param {Object} [opt={}] - 可選設定參數
 * @param {string} [opt.gTimeStart='2020-01-01T00:00:00'] - 抓取起始時間，ISO 字串格式
 * @param {string} [opt.dataInterval='1m'] - K 線時間間隔（如 '1m', '5m', '1h'）
 * @param {number} [opt.dataNum=60] - 每小時應抓取的資料筆數（與 interval 對應）
 * @param {string} [opt.fdData='./data'] - 資料儲存的根資料夾
 * @param {Object} [opt.proxy] - proxy 設定，用於 axios，例如 { protocol, host, port }
 * @param {boolean} [opt.useConvertToCsv=true] - 是否轉換成 CSV 字串並儲存
 * @param {number} [opt.timeSyncInterval=60000] - 同步間隔時間（毫秒），預設 1 分鐘
 * @param {boolean} [opt.useShowLog=false] - 是否顯示同步執行與完成的 log
 * @returns {Object} 返回一個控制物件，包含：
 * @returns {Function} return.run 啟動同步任務
 * @returns {Function} return.stop 停止同步任務
 */
let syncData = (name, type, endpoint, symbol, opt = {}) => {

    //gTimeStart
    let gTimeStart = get(opt, 'gTimeStart')
    if (!istime(gTimeStart)) {
        gTimeStart = '2020-01-01T00:00:00'
    }

    //dataInterval, K線時間間隔
    let dataInterval = get(opt, 'dataInterval')
    if (!isestr(dataInterval)) {
        dataInterval = '1m'
    }

    //dataNum, 每次抓取數據筆數
    let dataNum = get(opt, 'dataNum')
    if (!ispint(dataNum)) {
        dataNum = 60
    }
    dataNum = cint(dataNum)

    //fdData
    let fdData = get(opt, 'fdData')
    if (!isestr(fdData)) {
        fdData = './data'
    }

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

    //timeSyncInterval
    let timeSyncInterval = (opt, 'timeSyncInterval')
    if (!ispint(timeSyncInterval)) {
        timeSyncInterval = 60 * 1000 //1min
    }
    timeSyncInterval = cint(timeSyncInterval)

    //useShowLog
    let useShowLog = get(opt, 'useShowLog')
    if (!isbol(useShowLog)) {
        useShowLog = false
    }

    let t = null
    let b = false
    let core = () => {
        if (b) {
            return
        }
        b = true
        if (useShowLog) {
            console.log('syncData run...', ot().format('YYYY-MM-DDTHH:mm:ss'))
        }
        saveData(name, type, endpoint, symbol, {
            gTimeStart,
            dataInterval,
            dataNum,
            fdData,
            proxy,
            useConvertToCsv,
            useShowLog,
        })
            // .then(() => {
            // })
            .catch((err) => {
                console.log('err', err)
            })
            .finally(() => {
                b = false
                if (useShowLog) {
                    console.log('syncData finish')
                }
            })
    }

    let run = () => {
        core()
        t = setInterval(() => {
            core()
        }, timeSyncInterval)
    }

    let stop = () => {
        clearInterval(t)
    }

    return {
        run,
        stop,
    }
}


export default syncData
