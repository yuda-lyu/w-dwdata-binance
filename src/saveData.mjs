import path from 'path'
import fs from 'fs'
import ot from 'dayjs'
import get from 'lodash-es/get.js'
import size from 'lodash-es/size.js'
import sep from 'wsemi/src/sep.mjs'
import haskey from 'wsemi/src/haskey.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import isday from 'wsemi/src/isday.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import fsIsFile from 'wsemi/src/fsIsFile.mjs'
import fsIsFolder from 'wsemi/src/fsIsFolder.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import downloadData from './downloadData.mjs'


/**
 * 根據指定的時間範圍與設定，自動抓取並儲存指定時長的幣種 K 線資料（Kline）。
 * 若該小時已存在資料檔，且完整，則跳過；否則會下載並儲存成 CSV 檔。
 *
 * @async
 * @function saveData
 * @param {String} name - 資料名稱分類，例如幣種代號（如 BTC）
 * @param {String} type - 資料類型分類，例如 'spot', 'future' 等
 * @param {String} endpoint - 資料 API 端點（例如幣安的 K 線 API）
 * @param {String} symbol - 幣種交易對，例如 'BTCUSDT'
 * @param {String} interval - K 線間隔（如 '1m', '1h' 等）
 * @param {Object} [opt={}] - 可選設定參數
 * @param {String} [opt.dayStart='2020-01-01'] - 抓取起始時間（ISO 格式）
 * @param {String} [opt.fdData='./data'] - 儲存的根資料夾路徑
 * @param {Object} [opt.proxy] - axios proxy 設定（如 { protocol, host, port }）
 * @param {Boolean} [opt.useConvertToCsv=true] - 是否將資料轉為 CSV 格式儲存
 * @param {Boolean} [opt.useShowLog=false] - 是否顯示 log 資訊
 * @returns {Promise} 回傳Promise，resolve回傳成功訊息，reject回傳錯誤訊息
 */

let saveData = async(name, type, endpoint, symbol, interval, opt = {}) => {

    //kp
    let kp = {
        '1m': {
            dataInterval: '1m',
            hourInterval: 1,
            dataNum: 60,
        },
        '5m': {
            dataInterval: '5m',
            hourInterval: 4,
            dataNum: 48,
        },
        '15m': {
            dataInterval: '15m',
            hourInterval: 12,
            dataNum: 48,
        },
        '30m': {
            dataInterval: '30m',
            hourInterval: 24, //1天放一個檔案
            dataNum: 48,
        },
        '1hr': {
            dataInterval: '1h',
            hourInterval: 24 * 2, //2天放一個檔案
            dataNum: 48,
        },
        '4hr': {
            dataInterval: '4h',
            hourInterval: 24 * 8, //8天放一個檔案
            dataNum: 48,
        },
    }

    //check
    if (!haskey(kp, interval)) {
        console.log('kp', kp)
        throw new Error(`invalid interval[${interval}]`)
    }

    //dataInterval, 每筆時間間隔
    let dataInterval = kp[interval].dataInterval

    //dataNum, 每次抓取數據筆數
    let dataNum = kp[interval].dataNum

    //hourInterval, 每筆檔案儲存時長
    let hourInterval = kp[interval].hourInterval

    //dayStart
    let dayStart = get(opt, 'dayStart')
    if (!isday(dayStart)) {
        dayStart = '2020-01-01'
    }

    //timeStart
    let timeStart = `${dayStart}T00:00:00`

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

    //useShowLog
    let useShowLog = get(opt, 'useShowLog')
    if (!isbol(useShowLog)) {
        useShowLog = false
    }

    //fd
    let fd = path.resolve(fdData, name, type, interval)
    if (!fsIsFolder(fd)) {
        fsCreateFolder(fd)
    }
    // console.log('fd', fd)

    //_timeStart
    let _timeStart = timeStart
    // console.log('_timeStart', _timeStart)

    //now
    let now = ot()

    //_timeEnd
    let _timeEnd = now.format('YYYY-MM-DDTHH:mm:ss')
    // console.log('_timeEnd', _timeEnd)

    //rts, 生成_timeStart至_timeEnd內每4小時資訊
    let rts = []
    let t = _timeStart
    let vt = ot(_timeStart, 'YYYY-MM-DDTHH:mm:ss')
    let n = -hourInterval
    while (true) {

        //n
        n += hourInterval //每hourInterval小時

        //t
        t = vt.add(n, 'hour').format('YYYY-MM-DDTHH:mm:ss')
        // console.log('t', t)

        //tag
        let tag = ot(t, 'YYYY-MM-DDTHH:mm:ss').format('YYYYMMDDHHmmss')
        // console.log('tag', tag)

        //push
        rts.push({
            tag,
            t,
        })

        //check
        if (t > _timeEnd) { //最後時間一定要超過現在時間, 使能push下一個時間點(k+1)
            break
        }

    }
    // console.log('rts', rts, size(rts))

    //偵測既有檔案不抓, 若沒檔案就下載
    let csFin = ''
    if (true) {

        //up
        let up = size(rts) - 1

        let k = -1
        while (true) {
            k++
            if (k >= up) { //最末為下一個時間點(k=up), 為未來時間, 不須處理直接跳出
                break
            }

            //bLast, 最新時間段預設一定要下載
            let bLast = k === up - 1

            //tag, ts
            let tag = get(rts, `${k}.tag`)
            let ts = get(rts, `${k}.t`)
            let te = get(rts, `${k + 1}.t`)
            te = ot(te, 'YYYY-MM-DDTHH:mm:ss').add(-1, 'second').format('YYYY-MM-DDTHH:mm:ss') //截止時間須-1秒, 避免抓到下個時間段之起始數據
            // console.log(`get(rts, k)`, get(rts, k))
            // console.log(`get(rts, k+1)`, get(rts, k + 1))

            //fp
            let fp = `${fd}/${tag}.csv`
            // console.log('fp', fp)

            //ckComplete, 確認是否已下載
            let ckComplete = () => {

                let c = fs.readFileSync(fp, 'utf8')

                let s = sep(c, '\n')

                let n = size(s)

                let b = n !== dataNum //未有dataNum筆
                // let b2 = false //各筆之結束時間未完整
                // let b = b1 || b2
                if (b) {
                    console.log(`not complete: n[${n}]!==${dataNum}`, fp)
                }

                //若於當前時長內中斷不下載更新, 此時檔案內最末數據會不完全, 待下個時長再下載時, 數據筆數會相同, 故無法反應此不完全問題, 因考慮效能故忽略不計

                return b
            }

            //check
            let bNotExist = !fsIsFile(fp) //若指定時之檔案不存在就要下載
            let bNotComplete = null //若指定時之檔案不完整就要下載
            if (!bNotExist) {
                // console.log('ckComplete', fp)
                bNotComplete = ckComplete()
                // console.log('ckComplete', fp, bNotComplete)
            }
            let b = bNotExist || bNotComplete || bLast
            if (!b) {
                continue
            }

            if (useShowLog) {
                console.log(`get ${name} ${type} [${ts}] -> [${te}] downloading...`)
            }

            //cs
            let cs = await downloadData(endpoint, symbol, ts, te, dataInterval, {
                proxy,
                useConvertToCsv,
            })

            //check
            if (!isestr(cs)) {
                if (useShowLog) {
                    console.log(`get ${name} ${type} [${ts}] -> [${te}] no data`)
                }
                // console.log(tag, 'cs', cs)
                continue
            }

            if (useShowLog) {
                console.log(`get ${name} ${type} [${ts}] -> [${te}] finish`)
            }
            // console.log(tag, 'cs', cs)

            //save
            fs.writeFileSync(fp, cs, 'utf8')

            //update
            csFin = cs

        }

    }

    //timeLast, timeKeep
    let timeLast = '' //最新時間 //_timeEnd
    let timeKeep = '' //最近數據不變時間 //now.add(-1, 'hour').format('YYYY-MM-DDTHH:mm:ss')
    if (true) {

        let s = sep(csFin, '\n')

        let up = size(s) - 1

        let l0 = get(s, up - 0, '')
        let l1 = get(s, up - 1, '')

        let gt = (l) => {
            let ss = sep(l, ',')
            let t = get(ss, 0)
            return t
        }

        timeLast = gt(l0)
        timeKeep = gt(l1)

    }

    return {
        timeKeep,
        timeLast,
    }
}


export default saveData
