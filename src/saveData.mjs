import fs from 'fs'
// import path from 'path'
import ot from 'dayjs'
import get from 'lodash-es/get.js'
import size from 'lodash-es/size.js'
import sep from 'wsemi/src/sep.mjs'
import ispint from 'wsemi/src/ispint.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isbol from 'wsemi/src/isbol.mjs'
import istime from 'wsemi/src/istime.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import cint from 'wsemi/src/cint.mjs'
import fsIsFile from 'wsemi/src/fsIsFile.mjs'
import fsIsFolder from 'wsemi/src/fsIsFolder.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import downloadData from './downloadData.mjs'


/**
 * 根據指定的時間範圍與設定，自動抓取並儲存每小時的幣種 K 線資料（Kline）。
 * 若該小時已存在資料檔，且完整，則跳過；否則會下載並儲存成 CSV 檔。
 *
 * @async
 * @function saveData
 * @param {string} name - 資料名稱分類，例如幣種代號（如 BTC）
 * @param {string} type - 資料類型分類，例如 'spot', 'future' 等
 * @param {string} endpoint - 資料 API 端點（例如幣安的 K 線 API）
 * @param {string} symbol - 幣種交易對，例如 'BTCUSDT'
 * @param {Object} [opt={}] - 可選設定參數
 * @param {string} [opt.gTimeStart='2020-01-01T00:00:00'] - 抓取起始時間（ISO 格式）
 * @param {string} [opt.dataInterval='1m'] - K 線間隔（如 '1m', '1h' 等）
 * @param {number} [opt.dataNum=60] - 每小時應該抓取的資料筆數（預設 60，對應 1 分鐘線）
 * @param {string} [opt.fdData='./data'] - 儲存的根資料夾路徑
 * @param {Object} [opt.proxy] - axios proxy 設定（如 { protocol, host, port }）
 * @param {boolean} [opt.useConvertToCsv=true] - 是否將資料轉為 CSV 格式儲存
 * @param {boolean} [opt.useShowLog=false] - 是否顯示 log 資訊
 * @returns {Promise} 回傳Promise，resolve回傳成功訊息，reject回傳錯誤訊息
 */

let saveData = async(name, type, endpoint, symbol, opt = {}) => {

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

    //dataNum, 每次抓取數據筆數, 代表1hr數據量
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

    //useShowLog
    let useShowLog = get(opt, 'useShowLog')
    if (!isbol(useShowLog)) {
        useShowLog = false
    }

    // let tagsNotComplete = [
    //     '20200209100000',
    //     '20200219190000',
    //     '20200219200000',
    //     '20200219210000',
    //     '20200219220000',
    //     '20200219230000',
    //     '20200220000000',
    //     '20200220010000',
    //     '20200304170000',
    //     '20200304180000',
    //     '20200304190000',
    //     '20200425100000',
    //     '20200425110000',
    //     '20200425120000',
    //     '20200628100000',
    //     '20200628110000',
    //     '20200628120000',
    //     '20200628130000',
    //     '20201130140000',
    //     '20201221210000',
    //     '20201221220000',
    //     '20201221230000',
    //     '20201222000000',
    //     '20201222010000',
    //     '20201225100000',
    //     '20210211110000',
    //     '20210211120000',
    //     '20210306100000',
    //     '20210306110000',
    //     '20210420100000',
    //     '20210420110000',
    //     '20210420120000',
    //     '20210425120000',
    //     '20210425130000',
    //     '20210425140000',
    //     '20210425150000',
    //     '20210425160000',
    //     '20210813100000',
    //     '20210813110000',
    //     '20210813120000',
    //     '20210813130000',
    //     '20210813140000',
    //     '20210929150000',
    //     '20210929160000',
    //     '20230324200000',
    //     '20230324210000'
    // ]
    // let kpTagNotComplete = {}
    // each(tagsNotComplete, (v) => {
    //     kpTagNotComplete[v] = true
    // })

    //fd
    let fd = `${fdData}/${name}/${type}`
    if (!fsIsFolder(fd)) {
        fsCreateFolder(fd)
    }
    // console.log('fd', fd)

    //timeStart
    let timeStart = gTimeStart

    //timeEnd, 此刻+1hr, 此小時內已有之分鐘數據皆要抓
    let timeEnd = ot().add(1, 'hour').format('YYYY-MM-DDTHH:00:00')
    // console.log('timeStart', timeStart)
    // console.log('timeEnd', timeEnd)

    //rts, 生成timeStart至timeEnd內各小時資訊
    let rts = []
    let t = timeStart
    let vt = ot(timeStart, 'YYYY-MM-DDTHH:mm:ss')
    let n = 0
    while (true) {
        let tag = ot(t, 'YYYY-MM-DDTHH:mm:ss').format('YYYYMMDDHHmmss')
        // console.log('tag', tag)
        rts.push({
            tag,
            t,
        })
        n++
        t = vt.add(n, 'hour').format('YYYY-MM-DDTHH:mm:ss')
        // console.log('t', t)
        if (t > timeEnd) {
            break
        }
    }

    //偵測既有檔案與下載
    if (true) {
        let up = size(rts) - 1
        let k = -1
        while (true) {
            k++
            if (k >= up) {
                break
            }

            //tagHour
            let tagHour = ot().format('YYYY-MM-DDTHH:00:00')

            //tag, ts
            let tag = get(rts, `${k}.tag`)
            let ts = get(rts, `${k}.t`)
            let te = get(rts, `${k + 1}.t`)
            te = ot(te, 'YYYY-MM-DDTHH:mm:ss').add(-1, 'second').format('YYYY-MM-DDTHH:mm:ss') //截止時間須-1秒, 避免抓到下個小時之起始數據
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
                let b = n !== dataNum //須每小時有dataNum筆
                // let b2 = !haskey(kpTagNotComplete, tag) //須不在未完整名單中
                // let b = b1 && b2
                if (b) {
                    console.log(`not complete: n[${n}]!==${dataNum}`, fp)
                }
                return b
            }

            //check
            let bNotExist = !fsIsFile(fp) //若指定時之檔案不存在就要下載
            let bIsNow = tag === tagHour //若指定時之檔案為現在時就要下載
            let bNotComplete = null //若指定時之檔案不完整就要下載
            if (!bNotExist && !bIsNow) {
                bNotComplete = ckComplete()
            }
            let b = bNotExist || bIsNow || bNotComplete
            if (!b) {
                continue
            }

            //cs
            if (useShowLog) {
                console.log(`get ${name} ${type} ts[${ts}] -> te[${te}] downloading...`)
            }
            let cs = await downloadData(endpoint, symbol, ts, te, dataInterval, {
                proxy,
                useConvertToCsv,
            })
            if (useShowLog) {
                console.log(`get ${name} ${type} ts[${ts}] -> te[${te}] finish`)
            }
            // console.log(tag, 'cs', cs)

            //save
            fs.writeFileSync(fp, cs, 'utf8')

        }
    }

}


export default saveData
