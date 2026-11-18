# 規則帳本

本檔為套件設計與開發階段之規則帳本(藍圖),為要求程式碼須長成什麼樣,或由規格產出之測試(項目/說明/流程)有哪些,包含軸、單一擁有者、已知限制、破壞性變更紀錄,以及對應是哪些測試檔案或指令等,由agent自行編列、擴充與維護.當前已做到哪些記於`sgud/state/state.md`.過長時依類型拆為`rulebook_<類型>.md`,本檔只留索引.

本檔之規則源自使用端之需求(Gitea #183:新增週期鍵與依指定時區之界線合併),規格見`README.md`〈Intervals and day boundary〉與`src/intervals.mjs`、`src/saveData.mjs`之JSDoc.測試之執行:`npm test`;單檔:`npx mocha --no-parallel test/<檔> --timeout 180000`.

## 軸

- **週期鍵**(13):`1m`,`3m`,`5m`,`15m`,`30m`,`1hr`,`2hr`,`4hr`,`6hr`,`8hr`,`12hr`,`1day`,`1week`.既有六鍵=`1m`,`5m`,`15m`,`30m`,`1hr`,`4hr`.
- **取得方式**(`opt.aggregateFrom`):`'auto'`(預設,`undefined`與`null`視為未給)、`'none'`、基底週期鍵.
- **時區偏移**:期間(`dayStart`前1天至現在後366天)內之偏移集合:單一偏移(整點、半點、45分)、多偏移(日光節約或歷史改偏移)、無效(非IANA名、小於30分、非整分鐘).
- **輸出**:直接下載(資料夾`<週期鍵>`)、合併(資料夾`<週期鍵>_tz<±HHMM>_d<dayStart>_from<基底>`,基底`<基底>_tz<±HHMM>_d<dayStart>`).
- **下游可見之差異**:請求(送交易所之週期與區間)、資料夾與檔名、檔案內容與修改時間、回傳值、拋錯訊息與時機.

## 規則

### W1 週期表與不變式

- 週期表唯一來源為`getIntervals()`(`src/intervals.mjs`),每次回傳新物件;每鍵`hourInterval*3600 === dataNum*dataSec`;`dataInterval`為送交易所之週期(`1hr`→`1h`).不納入`1s`(合約端不支援)、`3d`(現貨與合約溢價指數之開盤對齊不同)、`1M`(長度不固定).
- 週期鍵之判定只認週期表自有之鍵(不經原型鏈:`'constructor'`、`'toString'`、`'__proto__'`皆不支援;wsemi之`haskey`以`in`判定,不可用於此).
- 盤點:`Grep "haskey\(" src`(應無對週期表之使用);`Grep "hasOwn\(" src/intervals.mjs`.
- 測試:`unit-intervals` I1、I5;`api-saveDataIntervals` T1(13鍵×2時區)、T2.

### W2 `aggregateFrom` 之預設與有效值(主控裁定 1、4)

- 未給(`undefined`、`null`)一律為`'auto'`,**不依週期鍵而異**(不留雙重語意).`'none'`=原生格線;基底週期鍵=以之為基底合併.
- 給了而無效(非字串、不是`auto`/`none`/週期鍵含原型鏈名、不整除目標或格線與時區之界線不對齊)即拋,**不改用預設**(改用預設會使輸出之界線靜默錯置),先於任何連網、建夾、寫檔.
- 盤點:`Grep "aggregateFrom" src`:僅`intervals.mjs`(判定)、`saveData.mjs`(傳給`getIntervalPlan`)、`syncData.mjs`(傳給`getIntervalPlan`與`saveData`).
- 測試:`unit-intervals` I2、I2b、I4、I4b;`api-saveDataAggregate` G7、G17;`api-saveDataIntervals` T7.

### W3 取得方式之決定(`getIntervalPlan`)

- 目標之原生格線於期間內各偏移下皆與時區之界線對齊者→直接下載(有日光節約之時區亦可,如`3m`、`1hr`);否則取「能整除目標且格線對齊」之最大原生週期為基底合併;`'none'`一律直接下載.
- 對齊判準:基底每根`b`秒、錨點`a`(`1week`為4天,其餘0),須整除目標秒數(故不長於目標)、且`(目標錨點-偏移秒-a) mod b === 0`.偏移為整分鐘,故`1m`恆為候選,auto一定有基底(`unit-intervals` I3b以多時區多週期鍵驗證不拋找不到基底).
- 回傳`{ interval, mode, key, base, baseKey, count, dataSec, utcOffset }`;`mode`為`'native'`或`'aggregate'`;`'none'`或多偏移時`utcOffset`為`null`.
- 測試:`unit-intervals` I2b、I3、I3b、I4;`api-saveDataAggregate` G1~G5.

### W4 直接下載之日界與分段

- 直接下載時各根以交易所之UTC格線起訖,`opt.timeZone`只決定時間字串之標示與分段起點;分段起點不在格點上者每段仍為應有筆數,末根之收棒晚於段終點,完整與否以末根之名目收棒判定(`checkDataComplete`);最新分段於首根開盤前回應為空時不寫檔、`timeLast`與`timeKeep`為`undefined`.
- 不送交易所之`timeZone`參數(合約之klines與溢價指數klines不解析).
- 測試:`api-saveDataIntervals` T1、T3~T6.

### W5 合併之規則

- 各根以時區之界線起訖(每根等長);開=首根之開、高=最高、低=最低、收=末根之收;量、成交額、筆數、主動買入量與額=十進位精確加總(字串→BigInt,不經浮點,小數位數取各根最大者),高低輸出原字串;開始時間=首根、結束時間=末根.
- 測試:`unit-aggregateData` A1、A2;`api-saveDataAggregate` G1~G4(與逐分鐘聚合之對照解逐位相同).

### W6 不齊之處置

- 目標根之基底各根須齊全且已定稿(基底所在分段檔之修改時間不早於該基底根之名目收棒加`opt.timeGrace`),否則不輸出並列入回傳之`aggregate.missing = [{ time, have, need, reason }]`(`open`/`gap`/`notFinal`/`invalidBase`;早於最早一根基底資料者不列).合併分段檔以修改時間判定是否重算,刪除即強制重算.
- 測試:`api-saveDataAggregate` G9、G10、G15.

### W7 固定偏移與時區檢測

- 須合併者,時區須於期間內為固定偏移,否則拋`invalid opt.timeZone: must be a fixed-offset time zone without daylight saving time, e.g. 'Etc/GMT+5' or '-05:00'`;直接下載者不要求(日光節約回撥之一小時內時間標示會重複,屬既有限制).
- 時區於所有取得方式(含`'none'`)皆先檢測:非執行環境可辨識之IANA名(含不支援偏移字串之執行環境)、偏移非整分鐘、絕對值小於30分之非零偏移皆拋(dayjs會把絕對值16以內之偏移值當成小時);偏移以Intl之`longOffset`取得,不經dayjs.
- 盤點:`Grep "timeZone" src/intervals.mjs`.
- 測試:`unit-intervals` I6、I7、I8;`api-saveDataAggregate` G3、G3b、G7、G8.

### W8 資料夾互不共用

- 合併之基底與合併之輸出皆不與直接下載之`<週期鍵>`資料夾共用,資料夾名含偏移與`dayStart`;不同時區或不同`dayStart`之呼叫各用各的資料夾.直接下載之資料夾與行為不變.
- 測試:`api-saveDataAggregate` G1、G6、G16.

### W9 既有六鍵於台北與UTC逐位不變(主控裁定 1)

- 既有六鍵未給`aggregateFrom`時,於`Asia/Taipei`與`UTC`下為直接下載:請求、資料夾、檔名、檔案內容與修改時間、回傳值、console輸出與舊版逐位相同.
- 於目標之原生格線與時區之界線不對齊之時區(UTC+5:30之`1hr`、UTC+9之`4hr`等)改為合併;有日光節約之時區而須合併者(如`America/New_York`之`4hr`)拋錯;明給`'none'`者為原生格線.以上為破壞性變更,寫於README〈Breaking changes〉.
- 測試:`api-saveDataIntervals` T7(以`'none'`之既有路徑對拍,12組);`api-saveDataAggregate` G4、G5、G8;與舊版之逐位對拍為一次性之核實(舊版不在本庫),方法見`sgud/exp/experience.md`.

### W10 訊息格式與拋錯時機(輸入參數檢測規格V17、V19、V20)

- 週期鍵無效:`invalid interval: must be one of <各週期鍵,以逗號加空白分隔>`(含非字串),不回顯輸入值,拋錯前不印週期表.
- `aggregateFrom`無效:`invalid opt.aggregateFrom: must be one of auto, none, <各週期鍵>`;不整除或不對齊:`invalid opt.aggregateFrom: must be an interval that divides interval and aligns with the boundaries of timeZone`.
- 時區:`invalid opt.timeZone: must be an IANA time zone name on this runtime, e.g. 'Etc/GMT-8'`、`must be zero or a UTC offset of at least 30 minutes`、`must be a time zone whose UTC offset is in whole minutes`、`must be a non-empty string`(僅直接呼叫`getOffsets`)、固定偏移之訊息見W7.
- 全部檢測先於任何副作用(連網、建夾、寫檔、啟動計時器).
- 測試:`unit-intervals` I4b、I5、I6;`api-saveDataIntervals` T2;`api-saveDataAggregate` G7、G8、G17.

### W11 `syncData`

- 建立時即以`getIntervalPlan`檢查週期鍵、`aggregateFrom`、`timeZone`,無效即拋(未啟動計時器、不建夾),並把`aggregateFrom`透傳給`saveData`.
- 測試:`api-saveDataAggregate` G14、G17.

### W12 回傳

- 直接下載:`{ timeKeep, timeLast, items }`,同舊版.合併:`items`為基底之下載分段,`timeLast`、`timeKeep`為最新兩根已輸出之目標根之開始時間,另含`aggregate: { key, base, baseKey, count, utcOffset, fd, segments, missing }`;乾跑不合併(`segments`、`missing`為空).
- 測試:`api-saveDataAggregate` G1、G5、G11.

## 站點與判準總表(盤點)

| 項 | 指令 | 預期 |
|---|---|---|
| 週期表之使用 | `Grep "getIntervals\(" src` | `intervals.mjs`(定義與計畫)、`saveData.mjs`(`saveNative`取表)、`aggregateData.mjs`(取分段長) |
| 取得方式之判定 | `Grep "getIntervalPlan\(" src` | `saveData.mjs`、`syncData.mjs`、`WDwdataBinace.mjs`(匯出) |
| 舊訊息殘留 | `Grep "invalid interval\[" src test` | 0 |
| 對週期表以`in`判定 | `Grep "haskey" src` | 0 |

## 破壞性變更紀錄

- 本次(相對1.0.59):見README〈Breaking changes〉——`aggregateFrom`預設一律`'auto'`、不支援之週期鍵之訊息、無效時區之拋錯時機、`syncData`建立時即檢查.
