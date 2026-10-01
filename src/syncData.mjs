import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import get from 'lodash-es/get.js'
import ispint from 'wsemi/src/ispint.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import isday from 'wsemi/src/isday.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import isp0int from 'wsemi/src/isp0int.mjs'
import cint from 'wsemi/src/cint.mjs'
import saveData from './saveData.mjs'


ot.extend(utc)
ot.extend(timezone)


/**
 * 建立一個定時同步資料的任務，定期呼叫 saveData 以抓取與儲存幣種 K 線資料。
 * 可啟動與停止，適合作為長時間後台資料同步機制。
 * 每輪呼叫 saveData 時以同步間隔之80%作為處理舊分段之時間上限(saveData之opt.timeBudget)，最新分段每輪必抓，長時間回補期間最新分段仍能持續更新。
 *
 * @function syncData
 * @param {string} name - 資料名稱分類，例如幣種（如 BTC）
 * @param {string} type - 資料類型分類，例如 'spot', 'future' 等
 * @param {string} endpoint - 資料來源 API 的網址（如 Binance K 線 API）
 * @param {string} symbol - 幣種交易對（如 'BTCUSDT'）
 * @param {Object} [opt={}] - 可選設定參數
 * @param {String} [opt.dayStart='2020-01-01'] - 抓取起始時間（ISO 格式）
 * @param {string} [opt.interval='1m'] - K 線時間間隔（如 '1m', '5m', '1h'）
 * @param {String} [opt.timeZone='Asia/Taipei'] - 時間字串與 epoch 互轉所用的固定時區（IANA 時區名，如 'UTC'、'Asia/Taipei'），與下載機器本地時區脫鉤，確保跨機器產出的時間標籤一致，並透傳給 saveData；僅支援無夏令時間之固定偏移時區，變更timeZone或dayStart時須改用新的fdData或刪除既有檔案
 * @param {string} [opt.fdData='./data'] - 資料儲存的根資料夾
 * @param {Object} [opt.proxy] - proxy 設定，用於 axios，例如 { protocol, host, port }
 * @param {boolean} [opt.useConvertToCsv] - 已停用：一律以 CSV 格式儲存（舊版給予false時會導致不儲存任何檔案）
 * @param {number} [opt.timeGrace=60000] - 名目收棒後之寬限毫秒數，透傳給 saveData，擷取時刻須不早於末根名目收棒加此值才視為定稿
 * @param {number} [opt.timeSyncInterval=60000] - 同步間隔時間（毫秒），預設 1 分鐘
 * @param {boolean} [opt.useShowLog=false] - 是否顯示同步執行與完成的 log
 * @returns {Object} 返回一個控制物件，包含：
 * @returns {Function} return.run 啟動同步任務
 * @returns {Function} return.stop 停止同步任務
 */
let syncData = (name, type, endpoint, symbol, opt = {}) => {

    //check
    if (!isestr(name)) {
        throw new Error('invalid name')
    }

    //check
    if (!isestr(type)) {
        throw new Error('invalid type')
    }

    //check
    if (!isestr(endpoint)) {
        throw new Error('invalid endpoint')
    }

    //check
    if (!isestr(symbol)) {
        throw new Error('invalid symbol')
    }

    //timeZone
    let timeZone = get(opt, 'timeZone')
    if (!isestr(timeZone)) {
        timeZone = 'Asia/Taipei'
    }

    //ott
    let ott = (input) => {
        if (input === undefined || input === null) {
            return ot().tz(timeZone)
        }
        return ot.tz(input, timeZone)
    }

    //dayStart
    let dayStart = get(opt, 'dayStart')
    if (!isday(dayStart)) {
        dayStart = '2020-01-01'
    }

    //interval, K線時間間隔
    let interval = get(opt, 'interval')
    if (!isestr(interval)) {
        interval = '1m'
    }

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

    //timeGrace, 名目收棒後之寬限(毫秒)
    let timeGrace = get(opt, 'timeGrace')
    if (!isp0int(timeGrace)) {
        timeGrace = 60 * 1000
    }
    timeGrace = cint(timeGrace)

    //timeSyncInterval
    let timeSyncInterval = get(opt, 'timeSyncInterval')
    if (!ispint(timeSyncInterval)) {
        timeSyncInterval = 60 * 1000 //1min
    }
    timeSyncInterval = cint(timeSyncInterval)

    //timeBudget, 每輪處理舊分段之時間上限, 取同步間隔之80%, 令單輪於下次觸發前結束而不被重入旗標略過
    let timeBudget = Math.floor(timeSyncInterval * 0.8)

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
            console.log('syncData run...', ott().format('YYYY-MM-DDTHH:mm:ss'))
        }
        saveData(name, type, endpoint, symbol, interval, {
            dayStart,
            timeZone,
            timeGrace,
            timeBudget,
            fdData,
            proxy,
            useShowLog,
        })
            .then((res) => {
                // console.log('res', res)
            })
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
