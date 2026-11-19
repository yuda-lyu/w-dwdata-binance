import get from 'lodash-es/get.js'
import iseint from 'wsemi/src/iseint.mjs'


//readIntOpt回傳之種類: 'unset'(undefined或null, 視為未給)、'invalid'(給了而無效)、'ok'(有效, value為轉換後之數值)
/**
 * 讀取opt之整數類選項(內部使用)：undefined與null視為未給；給了者以wsemi之iseint判定(數字或數字字串，非整數、Infinity、'0x10'、超出安全整數、超出spec範圍者無效)，有效者轉為數值後回傳(其後一律使用轉換值，數字字串'3'即3)。每個鍵只讀一次。
 *
 * @function readIntOpt
 * @param {Object} opt - 設定參數
 * @param {String} key - 鍵名
 * @param {Object} spec - iseint之範圍設定，例如 { use: 'count', min: 1 }
 * @returns {Object} 回傳物件 { state, value }，state為'unset'、'invalid'或'ok'，value僅於'ok'時有意義
 */
let readIntOpt = (opt, key, spec) => {
    let v = get(opt, key)
    if (v === undefined || v === null) {
        return { state: 'unset', value: undefined }
    }
    if (!iseint(v, spec)) {
        return { state: 'invalid', value: undefined }
    }
    let n = typeof v === 'string' ? Number(v.trim()) : v
    return { state: 'ok', value: n === 0 ? 0 : n } //-0以0計
}


export { readIntOpt }
export default readIntOpt
