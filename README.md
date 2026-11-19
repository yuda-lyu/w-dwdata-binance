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

## Retry, pending data and missing bars

抓與用分開：本套件只負責抓、重試與標註「交易所沒有這根」；遇缺數據時怎麼用(略過、不下單等)由使用端決定。

- **重試**：每段之請求失敗時重試 `opt.retryTimes`(預設 3)次，第 i 次前等 `opt.timeRetry × 3^(i−1)` 毫秒(預設 1、3、9 秒，每次不超過 `opt.timeRetryMax`，預設 60 秒)；單一請求逾時 `opt.timeRequest`(預設 30 秒，原無逾時而可永久卡住)。重試之情形：連線錯誤、逾時、HTTP 5xx、429(有 `Retry-After`(秒數或 HTTP 日期)且不超過 `timeRetryMax` 時依之)、403、HTTP 2xx 而回應非陣列；400 與其餘 4xx 不重試。請求成功時不多送請求、不多等待。公開之 `downloadData` 亦重試(回傳值之型別不變)。
- **停止本次執行之後續請求**(續送會延長封鎖或白等)：418(IP 封鎖)；429 之 `Retry-After` 超過上限或用盡重試；403(防火牆封鎖)用盡重試；連續 `opt.netFailTimes`(預設 3，0 為不停止)段皆為連線層失敗(連線錯誤、逾時)。未送之段列入 `failed`(`attempts: 0`)。
- **每次嘗試之分類**(以根為單位)：應有之根 = 分段請求起訖內之 UTC 原生格點且已收棒加寬限者(名目收棒 + `timeGrace` ≤ 該次請求前之時刻)。

| 該次嘗試 | 該根 |
|---|---|
| HTTP 2xx 陣列且含該根 | 有數據(清除其紀錄) |
| HTTP 2xx 陣列而不含該根(含空陣列) | 有效觀察(`lastKind: 'missing'`) |
| HTTP 4xx/5xx(400、403、418、429 除外)，且同一 K 線端點於本次執行對別的分段回過 2xx 陣列 | 有效觀察(`lastKind: 'httpError'`) |
| 同上而本次沒有任何 2xx 陣列回應(例：只下載單一分段而該段回錯誤、端點路徑有誤而一律 404)；連線錯誤、逾時；400(參數錯誤)、403、418、429；2xx 而回應非陣列；3xx 等其餘非 2xx(如代理之轉址頁面) | 不算觀察(只累計既有紀錄之 `uncounted`) |

- **標註缺根**：有效觀察(每次執行每根至多 1 次)累計 ≥ `opt.noDataTimes`(預設 3)且首次與最近一次相隔 ≥ `opt.timeNoData`(預設 604800000 毫秒 = 7 天)時，於該次有效觀察標註為 `nodata`，之後該段若只缺已標註之根即為完整而不再請求；未達者為 `pending`(暫無數據)，其分段每次執行都重抓(`items[].reason` 為 `'pending'`)。不算觀察之嘗試不改有效觀察之次數與時刻，故斷線期間不會被標註。標註後不定期重新確認。「相隔」依主機之時鐘：主機時鐘向前跳會提早標註。
- **紀錄檔**：每個資料夾一個 `_gaps.json`，與分段 CSV 同夾(分段只讀 `.csv`，紀錄檔與其暫存檔 `_gaps.json.<pid>.tmp` 不會被當成分段)；只在該資料夾有 `pending` 或 `nodata` 之根時存在，沒有時不存在(沒有缺根時不新增任何檔)，合併時只放在基底資料夾。每次執行讀一次、有變動才以「寫暫存檔再改名」覆寫；各範圍帶所屬分段 `tag`，同一分段內連續且紀錄相同之根合併為一個範圍(跨分段不合併)，檔內每個範圍一列。讀取時逐範圍檢查(檔頭之 `v`、`interval`、`timeZone`；`tag` 為 14 位數字；狀態、次數、時刻；`from` 於原生格線上且於該 `tag` 之分段請求起訖內；`n` 與 `to` 一致；全檔各範圍不重疊；有日光節約之時區之直接下載，跨回撥之分段實際比名目長 1 小時，故容許 2 小時餘裕)，檔案超過 64 MiB 或大括號之數量遠多於合法範圍之可能數量(以空物件灌滿)者亦同；不合格者整檔視為無紀錄(不拋錯、不提早標註，重新累計，下次寫入時以正確內容覆蓋，無紀錄則刪除)。檔頭之 `interval` 或 `timeZone` 與本次呼叫不符者亦視為無紀錄(直接下載者變更 `timeZone` 時請改用新的 `fdData`，同分段檔之限制)。上限之理由：最壞情形為最小週期(`1m`，每段 1 小時)自 2017 年至今約 8 萬個分段皆為上市前，每段一個範圍(約 330 位元組)約 27 MB，上限取其 2 倍餘。
- **手動重置**：刪除紀錄檔，或對 `saveData` 給 `opt.useResetGaps: true`(本次先刪除期間內各分段之範圍並寫入，期間外之分段之範圍不動；乾跑不刪；`syncData` 不透傳)。`useResetGaps` 只有 `true` 為啟用，其餘值視為未給(不拋)。
- **回傳**(只在非空時出現；請求皆成功且無缺根時回傳與既有相同)：`failed: [{ tag, ts, te, kind, httpStatus, code, attempts, counted }]` 為本次請求失敗之分段(`counted` 為是否為有效觀察，`false` 即「本次未問到」)；`gaps: [{ tag, from, to, n, state, validCount, firstValid, lastValid, lastKind, lastHttpStatus, lastCode, uncounted, lastUncountedKind, markedAt }]` 為期間內(`dayStart` 至現在之各段)全部 `pending` 與 `nodata` 之根(取自該資料夾之紀錄檔)。不呼叫 `saveData` 而讀取：`readGaps(fdData, name, type, folder)`(不限期間；亦掛於 `WDwdataBinace()`；合併者之基底之 `folder` 為 `getIntervalPlan(...).baseKey`)。

`_gaps.json` 之內容(每範圍一列，此處為排版而折行)：

```json
{
  "v": 1,
  "interval": "4hr",
  "timeZone": "Asia/Taipei",
  "ranges": [
    {"tag":"20200215000000","from":"2020-02-19T20:00:00","to":"2020-02-19T20:00:00","n":1,"state":"pending",
     "validCount":1,"firstValid":"2026-11-19T03:11:01.128Z","lastValid":"2026-11-19T03:11:01.128Z",
     "lastKind":"missing","lastHttpStatus":200,"lastCode":null,
     "uncounted":0,"lastUncountedKind":null,"markedAt":null}
  ]
}
```

**新選項**(`opt`；`downloadData`、`saveData`、`syncData` 之適用見表；`syncData` 於建立時檢測並透傳給 `saveData`)：

| 選項 | 預設 | 適用 | 意義 | 給了而無效 |
|---|---|---|---|---|
| `retryTimes` | 3 | `downloadData`、`saveData`、`syncData` | 請求失敗後之重試次數(非負整數；0 = 不重試) | 改用預設 |
| `timeRetry` | 1000 | 同上 | 退避之基數(毫秒，非負整數，上限 2147483647) | 改用預設 |
| `timeRetryMax` | 60000 | 同上 | 每次等待之上限(毫秒，非負整數，上限 2147483647)；`Retry-After` 超過即停止本次執行 | 改用預設 |
| `timeRequest` | 30000 | 同上 | 單一請求之逾時(毫秒，正整數，上限 2147483647) | 改用預設 |
| `netFailTimes` | 3 | `saveData`、`syncData` | 連續此數之分段皆為連線層失敗時停止本次執行(非負整數；0 = 不停止) | 改用預設 |
| `noDataTimes` | 3 | `saveData`、`syncData` | 標註所需之有效觀察次數(正整數) | **拋** `invalid opt.noDataTimes: must be a positive integer` |
| `timeNoData` | 604800000 | `saveData`、`syncData` | 標註所需之首末有效觀察相隔(毫秒，非負整數) | **拋** `invalid opt.timeNoData: must be a non-negative integer` |
| `useResetGaps` | false | `saveData` | 本次先刪除期間內各分段之紀錄 | 只有 `true` 為啟用，其餘視為未給 |

- `undefined`、`null` 視為未給(用預設)。整數類接受數字字串(如 `'3'`、`' 50 '`、`'1e3'`)並轉為數值後使用；非整數、`Infinity`、`NaN`、`'0x10'`、超出安全整數或超出上限者為無效。
- `noDataTimes` 與 `timeNoData` 決定何時永久標註為缺根、之後不再抓(改用預設會使資料靜默缺漏)，故給了而無效即拋(先於任何連網、建夾、寫檔；`saveData` 為 reject，`syncData` 於建立時同步拋，未啟動計時器)，訊息不帶輸入值；其餘為執行參數，無效改用預設(不拋)。
- **合併**：`aggregate.missing` 中 `reason: 'gap'` 之元素，於缺之基底根有紀錄或其分段本次請求失敗時另含 `cause`(最嚴者：`'unobserved'` 基底分段本次請求失敗而無資料 > `'unknown'` 尚未嘗試 > `'pending'` > `'nodata'`)與 `causes: { pending, nodata, unobserved, unknown }`(根數)，含 `pending` 者另含 `validCount`(最少)與 `firstValid`(最早)；缺之基底根全為 `'unknown'`(無紀錄且本次未失敗，例：`timeBudget` 留待下次之基底段、分段檔殘缺)時不附(同既有)。基底第一段請求失敗時，其目標根原被當成上市前而不列入 `missing`，現列入(不論該失敗是否為有效觀察)；真正上市前(未失敗)之 `pending`、`nodata` 照舊不列(可由 `gaps` 查得)。
- 使用端之實測(2026-11-19，公開端點；本庫之測試只連本機假交易所，未重驗)：交易所之「沒有該根」皆為 HTTP 200 而缺根(上市前與未來為空陣列；已下架之交易對仍回其舊資料)，錯誤回應只見於參數錯誤；現貨 ETHUSDT 與 BTCUSDT 之 4h 於 2020-02-19 12:00(UTC)缺 1 根。

### Breaking changes

相對於 1.0.59 之 `saveData`／`syncData`(各項之修前、修後行為有對應測試，見 `sgud/rule/rulebook.md`)。盤點既有呼叫是否受影響：對各呼叫之 `interval` 與 `opt`(`timeZone`、`dayStart`)執行 `getIntervalPlan(interval, opt)`(不連網)，`mode` 為 `'aggregate'` 者改為合併，拋錯者為下列被收嚴之情形，`mode` 為 `'native'` 且 `key` 同 `interval` 者不受影響。

- **`aggregateFrom` 之預設一律為 `'auto'`**(1.0.59 無此選項，一律直接下載)：既有之 `1m`、`5m`、`15m`、`30m`、`1hr`、`4hr` 於 `Asia/Taipei`(預設)與 `UTC` 下仍為直接下載，請求、資料夾、檔名、內容與回傳皆不變；於目標之原生格線與 `timeZone` 之界線不對齊之時區(例：UTC+5:30 之 `1hr`、UTC+9 之 `4hr`)改為依該時區之界線合併(存於新資料夾、回傳多一個 `aggregate`)；於有日光節約之時區而須合併者(例：`America/New_York` 之 `4hr`)改為拋錯。需保持原生格線者請明給 `aggregateFrom: 'none'`。時區之偏移依 `dayStart` 前 1 天至現在後 366 天計，故 `dayStart` 早於 1980 年之 `Asia/Taipei`(歷史上曾有日光節約)亦視為有日光節約，其須合併者(如 `4hr`)拋錯。
- 不支援之週期鍵之錯誤訊息由 `invalid interval[<值>]`(並先印出週期表)改為 `invalid interval: must be one of <各週期鍵>`，不回顯輸入值、不再印週期表；非字串之 `interval` 亦同(原為 `invalid interval`)。原型鏈成員名(如 `'constructor'`、`'toString'`)原被接受(不下載任何分段、卻建立同名資料夾)，現同為不支援而拋錯。
- `timeZone` 無效(IANA 時區名不被執行環境辨識、絕對值小於 30 分之非零偏移)時，改於任何連網、建夾、寫檔前拋 `invalid opt.timeZone: ...`(原於建立分段資料夾後才拋原生錯誤)。
- `syncData` 於建立時即檢查 `interval`、`aggregateFrom`、`timeZone`，無效即拋(未啟動計時器)；原為每輪於 `saveData` 失敗而只印錯誤。
- 重試、暫無數據與缺根之標註(相對於 1.0.61；請求皆成功且沒有缺根時，請求(含標頭)、檔案(名稱、內容、修改時間)、console 輸出與回傳皆不變)：請求失敗時多送至多 3 次請求並等待(預設共約 13 秒；公開之 `downloadData` 亦然)；不回應者 30 秒逾時(原永久卡住)；HTTP 2xx 而回應非陣列者改為重試，每次嘗試各印一行 `invalid response for symbol[...]`(原印一次)；請求失敗之 console 訊息由印出整個錯誤物件改為 `can not get k-data for symbol[<交易對>] kind[...] status[...] code[...] attempts[...]`；418、429 超過上限或用盡重試、403 用盡重試、連續 3 段連線層失敗後不再送出本次之後續請求；有缺根之資料夾新增紀錄檔 `_gaps.json`(每資料夾一個)、`items[].reason` 改為 `'pending'`、回傳多 `failed`／`gaps`，標註後不再請求該段(原每輪重抓)；`aggregate.missing` 之 `'gap'` 元素於缺之基底根有紀錄或本次失敗時多 `cause`、`causes`(與 `validCount`、`firstValid`)；基底第一段請求失敗時其目標根改為列入 `missing`；`WDwdataBinace()` 多 `readGaps`。新選項之檢測：`noDataTimes`、`timeNoData` 給了而無效即拋 `invalid opt.<名稱>: must be <種類>`(`saveData` 為 reject、`syncData` 於建立時拋)，其餘新選項(`retryTimes`、`timeRetry`、`timeRetryMax`、`timeRequest`、`netFailTimes`)無效改用預設、`useResetGaps` 只有 `true` 為啟用；整數類接受數字字串並轉為數值。資料夾內除分段 CSV 外，可能多出 `_gaps.json`(讀取分段者請只取 `.csv`)。
