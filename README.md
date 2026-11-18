# w-dwdata-binance
A download tool for binace.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-dwdata-binance.svg?style=flat)](https://npmjs.org/package/w-dwdata-binance) 
[![license](https://img.shields.io/npm/l/w-dwdata-binance.svg?style=flat)](https://npmjs.org/package/w-dwdata-binance) 
[![npm download](https://img.shields.io/npm/dt/w-dwdata-binance.svg)](https://npmjs.org/package/w-dwdata-binance) 
[![npm download](https://img.shields.io/npm/dm/w-dwdata-binance.svg)](https://npmjs.org/package/w-dwdata-binance) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-dwdata-binance.svg)](https://www.jsdelivr.com/package/npm/w-dwdata-binance)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-dwdata-binance/global.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-dwdata-binance
```

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-dwdata-binance/blob/master/g-BTCUSDT.mjs)]
```alias
import WDwdataBinace from 'w-dwdata-binance'

function test() {

    //wdd
    let wdd = WDwdataBinace()

    //BTC
    let name = 'BTC'

    //price
    let type = 'price'

    //幣安API的klines
    let endpoint = 'https://api.binance.com/api/v3/klines'

    //BTCUSDT交易對
    let symbol = 'BTCUSDT'

    //p
    let p = wdd.syncData(name, type, endpoint, symbol, { useShowLog: true })

    //run
    p.run()

}
test()
//get BTC price ts[2020-01-02T11:00:00] -> te[2020-01-02T11:59:59] downloading...
//get BTC price ts[2020-01-02T11:00:00] -> te[2020-01-02T11:59:59] finish
//get BTC price ts[2020-01-02T12:00:00] -> te[2020-01-02T12:59:59] downloading...
//get BTC price ts[2020-01-02T12:00:00] -> te[2020-01-02T12:59:59] finish
//get BTC price ts[2020-01-02T13:00:00] -> te[2020-01-02T13:59:59] downloading...
//continuing...
```

## Intervals and day boundary

`saveData` 之 `interval` 與 `syncData` 之 `opt.interval` 為週期鍵(直接下載時亦為存檔子資料夾名)：

| 週期鍵 | 送交易所 | 每段時長 | 每段筆數 |
|---|---|---|---|
| `1m` | `1m` | 1 小時 | 60 |
| `3m` | `3m` | 3 小時 | 60 |
| `5m` | `5m` | 4 小時 | 48 |
| `15m` | `15m` | 12 小時 | 48 |
| `30m` | `30m` | 1 天 | 48 |
| `1hr` | `1h` | 2 天 | 48 |
| `2hr` | `2h` | 4 天 | 48 |
| `4hr` | `4h` | 8 天 | 48 |
| `6hr` | `6h` | 12 天 | 48 |
| `8hr` | `8h` | 16 天 | 48 |
| `12hr` | `12h` | 24 天 | 48 |
| `1day` | `1d` | 48 天 | 48 |
| `1week` | `1w` | 48 週 | 48 |

- 交易所之 `3d`(現貨與合約溢價指數之開盤對齊不同)、`1M`(每根長度不固定)、`1s`(合約不支援)不支援；不在上表之週期鍵(含交易所字串如 `'1h'`、`'1d'`)拋 `invalid interval: must be one of ...`。
- 交易所原生之格線以 UTC 為錨(`1day` 為 UTC 00:00，`1week` 為週一 UTC 00:00)。本套件不送交易所之 `timeZone` 參數(合約之 klines 與溢價指數 klines 不支援，帶了也被忽略)。
- 取得方式由 `opt.aggregateFrom` 決定，**未給(`undefined` 或 `null`)時一律為 `'auto'`，不分週期鍵**；可用 `getIntervalPlan(interval, opt)` 預先查得(不連網)：

| `aggregateFrom` | 得到 | 存檔資料夾 |
|---|---|---|
| `'auto'`(預設) | 原生格線於期間內之各偏移下皆與 `opt.timeZone` 之界線對齊者(例：台北之 `1m`、`5m`、`15m`、`30m`、`1hr`、`2hr`、`4hr`、`8hr`，UTC 之 `1day`，任何時區之 `3m`)直接下載原生週期，各根以交易所之 UTC 格線起訖；不對齊者下載能整除目標且對齊之最大原生週期後合併，各根以該時區之界線起訖(例：台北之 `1day` = 當地 00:00 ~ 24:00，由 `8hr` 合併 3 根；UTC+9 之 `4hr` 由 `1hr` 合併 4 根；UTC+5:30 之 `1hr` 由 `30m` 合併 2 根，`1day` 由 `30m` 合併 48 根) | 直接下載者為 `<週期鍵>`；合併者為 `<週期鍵>_tz<±HHMM>_d<dayStart>_from<基底>`(例 `1day_tz+0800_d20200101_from8hr`)，基底存於 `<基底>_tz<±HHMM>_d<dayStart>`(例 `8hr_tz+0800_d20200101`) |
| `'none'` | 一律直接下載原生週期，各根以交易所之 UTC 格線起訖；`opt.timeZone` 只決定時間字串之標示與分段起點(例：台北之 `1day` 各根標為 `YYYY-MM-DDT08:00:00`) | `<週期鍵>` |
| 週期鍵(如 `'1hr'`) | 以之為基底合併(須能整除目標且其格線與時區之界線對齊，否則拋 `invalid opt.aggregateFrom: must be an interval that divides interval and aligns with the boundaries of timeZone`)；與目標相同且於各偏移下皆對齊者即直接下載 | 同 `'auto'` 之合併者 |

- `aggregateFrom` 給了而無效(非字串、非 `'auto'`／`'none'`／上表之週期鍵)即拋 `invalid opt.aggregateFrom: must be one of auto, none, ...`，不改用預設(改用預設會使輸出之界線靜默錯置)。週期鍵、`aggregateFrom`、`timeZone` 無效時之拋錯皆先於任何連網、建夾、寫檔，訊息不帶輸入值。
- 合併所用之基底與合併之輸出皆不與直接下載之 `<週期鍵>` 資料夾共用；資料夾名含偏移與 `dayStart`，故同一 `fdData` 下以不同時區或不同 `dayStart` 呼叫者各用各的資料夾，不會互相覆蓋或錯位(代價：同時直接下載同一週期者會重複下載)。讀取合併之序列請用回傳之 `aggregate.fd`，或以 `getIntervalPlan(...).key` 組路徑。
- 合併之規則：開 = 首根之開、高 = 最高、低 = 最低、收 = 末根之收；量、成交額、筆數、主動買入之量與額 = 十進位精確加總；開始時間 = 首根之開始時間、結束時間 = 末根之結束時間。基底不齊、未收棒加寬限(`opt.timeGrace`)或擷取於收棒前之目標根不輸出，列於回傳之 `aggregate.missing`。
- **不同基底之結果可能不同**：交易所於少數維護日各週期之資料不一致(實測溢價指數由 `8hr` 與由 `4hr` 合併之台北日線，2020 ~ 2026 年約 10 日不等，多為筆數欄；價格無此現象)。需與既有資料可比、或要長期穩定者，請明給 `aggregateFrom`(基底週期鍵)。
- **價格與溢價指數須同基底同界線**：請以相同之 `aggregateFrom`(或同一個基底週期鍵)與 `timeZone`、`dayStart` 呼叫，並比對兩者回傳之 `aggregate.key`(或 `getIntervalPlan(...).key`)是否相同。
- 須合併時 `timeZone` 須為固定偏移(每根等長，不提供 23 或 25 小時之日)：有日光節約時間、或於 `dayStart` 至現在後 1 年內改過偏移之時區拋 `invalid opt.timeZone: must be a fixed-offset time zone without daylight saving time, ...`，請改給固定偏移(如 `'Etc/GMT+5'`、`'Etc/GMT-8'`；執行環境之 Intl 支援偏移字串時亦可 `'-05:00'`、`'+08:00'`)。`'auto'` 而原生格線於各偏移下皆對齊者(例：有日光節約之時區之 `3m`、`1hr`)為直接下載，不要求固定偏移，但於日光節約回撥之一小時內，時間標示會重複(與既有之直接下載相同)。偏移須為 0 或絕對值至少 30 分(`invalid opt.timeZone: must be zero or a UTC offset of at least 30 minutes`)；時區須為執行環境可辨識之 IANA 時區名(`invalid opt.timeZone: must be an IANA time zone name on this runtime, e.g. 'Etc/GMT-8'`)。

### Breaking changes

相對於 1.0.59 之 `saveData`／`syncData`(各項之修前、修後行為有對應測試，見 `sgud/rule/rulebook.md`)。盤點既有呼叫是否受影響：對各呼叫之 `interval` 與 `opt`(`timeZone`、`dayStart`)執行 `getIntervalPlan(interval, opt)`(不連網)，`mode` 為 `'aggregate'` 者改為合併，拋錯者為下列被收嚴之情形，`mode` 為 `'native'` 且 `key` 同 `interval` 者不受影響。

- **`aggregateFrom` 之預設一律為 `'auto'`**(1.0.59 無此選項，一律直接下載)：既有之 `1m`、`5m`、`15m`、`30m`、`1hr`、`4hr` 於 `Asia/Taipei`(預設)與 `UTC` 下仍為直接下載，請求、資料夾、檔名、內容與回傳皆不變；於目標之原生格線與 `timeZone` 之界線不對齊之時區(例：UTC+5:30 之 `1hr`、UTC+9 之 `4hr`)改為依該時區之界線合併(存於新資料夾、回傳多一個 `aggregate`)；於有日光節約之時區而須合併者(例：`America/New_York` 之 `4hr`)改為拋錯。需保持原生格線者請明給 `aggregateFrom: 'none'`。時區之偏移依 `dayStart` 前 1 天至現在後 366 天計，故 `dayStart` 早於 1980 年之 `Asia/Taipei`(歷史上曾有日光節約)亦視為有日光節約，其須合併者(如 `4hr`)拋錯。
- 不支援之週期鍵之錯誤訊息由 `invalid interval[<值>]`(並先印出週期表)改為 `invalid interval: must be one of <各週期鍵>`，不回顯輸入值、不再印週期表；非字串之 `interval` 亦同(原為 `invalid interval`)。原型鏈成員名(如 `'constructor'`、`'toString'`)原被接受(不下載任何分段、卻建立同名資料夾)，現同為不支援而拋錯。
- `timeZone` 無效(IANA 時區名不被執行環境辨識、絕對值小於 30 分之非零偏移)時，改於任何連網、建夾、寫檔前拋 `invalid opt.timeZone: ...`(原於建立分段資料夾後才拋原生錯誤)。
- `syncData` 於建立時即檢查 `interval`、`aggregateFrom`、`timeZone`，無效即拋(未啟動計時器)；原為每輪於 `saveData` 失敗而只印錯誤。
