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
- 請求失敗或有缺根時之新欄位見W16;請求皆成功且無缺根時回傳與上列相同(不含新欄位).

### W13 重試與逾時

- 原則:抓與用分開;每次抓取重試,取不到先視為暫無數據(W15).
- 每段一次嘗試 = 最多 1 + `retryTimes`(預設3)次請求;第i次重試前等`timeRetry × 3^(i−1)`毫秒(預設1、3、9秒),每次不超過`timeRetryMax`(預設60000);429附`Retry-After`(秒數或HTTP日期)且不超過上限時依之.
- 重試之情形:連線錯誤、逾時、HTTP 5xx、429、403、HTTP 2xx而回應非陣列;不重試:400、其餘4xx、418.
- 停止本次執行之後續請求(未處理之段列入`failed`,`attempts: 0`,不算觀察):418;429之`Retry-After`超過上限或用盡重試;403用盡重試;連續`netFailTimes`(預設3,0為不停止)段皆為連線層失敗(連線錯誤、逾時),其間有其他結果之段則重新計數.
- 單一請求自送出至收完回應超過`timeRequest`(預設30000)即中止(原無逾時、可永久卡住).
- 請求成功時不多送請求、不多等待、不多印;等待一律經`src/timers.mjs`之`sleep`(測試注入以記錄而不真的等).
- 新選項之檢測(`src/opts.mjs`之`readIntOpt`,以wsemi`iseint`判定):`undefined`與`null`視為未給(用預設);整數類接受數字字串並轉為數值後使用(K7、K4:`'3'`即3),非整數、`Infinity`、`NaN`、`'0x10'`、布林、物件、超出安全整數或範圍者無效.範圍:次數(`retryTimes`、`netFailTimes`)為`use: 'count'`(0~4294967295),計時毫秒(`timeRetry`、`timeRetryMax`、`timeRequest`)為`use: 'timer'`(0~2147483647,`timeRequest`須≥1;超過者`setTimeout`會改以1毫秒觸發),`noDataTimes`須≥1(安全整數,以極大之次數表示「不標註」為合法用法),`timeNoData`須≥0(安全整數).
  - **給了而無效即拋**`invalid opt.<名稱>: must be <種類>`(不帶輸入值;V17先於任何連網、建夾、寫檔;`saveData`為reject、`syncData`於建立時同步拋、未啟動計時器):`noDataTimes`、`timeNoData`——決定何時永久標註為缺根、之後不再抓,改用預設會使資料靜默缺漏(決定資料口徑之opt,規格§11).
  - **給了而無效改用預設(不拋)**(K3):`retryTimes`、`timeRetry`、`timeRetryMax`、`timeRequest`、`netFailTimes`(執行參數,含公開之`downloadData`).
  - `useResetGaps`:只有`true`為啟用,其餘值視為未給(不拋).
- 測試:`api-requestKlines` K1~K13;`api-saveDataGaps` S4、S11、S12、S14、S17、S18、S23;`api-saveData` I7、I7b、I10;`unit-gaps` U6.

### W14 每次嘗試之分類

- 應有之根 = 分段請求起訖(同`downloadData`之`startTime`、`endTime`)內之UTC原生格點(`1week`加4天錨點),且名目收棒加`timeGrace`不晚於該次請求前之時刻(恰等於者計入);不以`dataNum`判定.
- 已取得之根 = 該次回應之各根 ∪ 嘗試後分段檔之各根;應有而未取得者依該次嘗試分類:2xx陣列(含空陣列) ⇒ 有效觀察(`missing`);4xx/5xx(400、403、418、429除外)且同一K線端點於本次執行對別的分段回過2xx陣列 ⇒ 有效觀察(`httpError`);其餘(連線錯誤、逾時、400、403、418、429、2xx而非陣列、3xx等其餘非2xx、本次無任何2xx陣列回應之4xx/5xx) ⇒ 不算觀察.不以其他端點(如時間端點)補認可達:只下載單一分段而該段回錯誤、或端點路徑有誤而一律404,皆不計.
- 每次執行每根至多1次有效觀察(每段每次執行只嘗試一次).
- 測試:`api-saveDataGaps` S8、S8x、S9、S10、S19;`unit-gaps` U1;`api-requestKlines` K9.

### W15 標註、紀錄檔、完整性、手動重置

- 標註(於有效觀察之當下判定):有效觀察 ≥ `noDataTimes`(預設3),且首次與最近一次有效觀察相隔 ≥ `timeNoData`(預設604800000;依主機時鐘,向前跳會提早標註).不算觀察只累計`uncounted`,不改次數與時刻;已標註者不再累計;任何一次取得該根即刪除其紀錄.
- 紀錄檔**每資料夾一個**`_gaps.json`(與分段CSV同夾;分段只讀`.csv`,故紀錄檔與暫存檔`_gaps.json.<pid>.tmp`不會被當成分段;合併時只在基底資料夾):`{ v: 1, interval, timeZone, ranges: [{ tag, from, to, n, state, validCount, firstValid, lastValid, lastKind, lastHttpStatus, lastCode, uncounted, lastUncountedKind, markedAt }] }`;各範圍帶所屬分段`tag`,同一分段內連續且紀錄相同之根合併為一個範圍(跨分段不合併),檔內每範圍一列;依`tag`與起點排序;無任何`pending`與`nodata`時不存在(清空即刪檔).
- 讀寫(`src/gaps.mjs`之`openGapStore`):**每次執行讀一次**(檔不存在時不讀;`saveData`讀入後交給`aggregateData`共用,不重讀)、**有變動才寫**(未更動不寫、不改修改時間),寫入為先寫暫存檔再改名(原子);只在需要逐根更新之分段才展開範圍,其餘分段之範圍(含時間字串)原樣保留;寫入失敗印`can not save file`而不中斷(回傳之`gaps`為記憶體中之本次紀錄).
- 讀取時逐範圍檢查:檔頭`v`為1、`interval`為週期表之鍵、`timeZone`非空字串、`ranges`為非空陣列(給了呼叫端之週期鍵與時區者,檔頭須相符,不符即整檔視為無紀錄);`tag`為14位數字;`state`、`validCount`(1以上)與`uncounted`(0以上)為整數且不超過上限(10^9)、`firstValid`與`lastValid`可解析、`markedAt`於`nodata`時可解析而於`pending`時為`null`、`lastKind`、`lastHttpStatus`、`lastCode`、`lastUncountedKind`之型別;自`from`起之`n`根皆於原生格線上且於該`tag`分段之請求起訖內(以算術判定,`n`過大即不合格,不逐根展開;有日光節約之時區之直接下載,分段起訖為線性之牆鐘字串,跨回撥之分段實際比名目長1小時,故上界容許2小時餘裕)、`to`與`from`、`n`一致(`n`為1而`to`與`from`為同一字串者免再解析,`n`大於1而`to`與`from`同字串者不合格)、全檔各範圍之根不重疊(含不同`tag`解析為同一時刻者)、檔案不超過64MiB、大括號之數量不遠多於合法範圍之可能數量(`JSON.parse`前先擋下以空物件灌滿之巨檔,免得建出數千萬個物件);不合格者整檔視為無紀錄(不拋錯、不提早標註),下次更新時以正確內容覆蓋(無紀錄則刪除);`readGaps`於不合格時回空陣列.
  - **檔案上限64MiB之理由**:粒度由每段一檔改為每資料夾一檔後,大小隨有缺根之分段數增加;每範圍約300~350位元組,每個有缺根之分段至少一個範圍.最壞情形為最小週期`1m`(每段1小時)自2017年至今約8萬個分段全為上市前,每段一個範圍約27MB;取其2倍餘,使合法之檔不致被拒而丟失累計(丟失即須重新觀察至少7天),同時令損毀之巨檔不被讀入.
- 完整性(只在紀錄中有該分段時生效):有`pending` ⇒ `'pending'`(每次執行重抓);只有`nodata` ⇒ 分段檔之筆數 = 應有之根 − 已標註之根且末根已定稿即完整;整段皆已標註者無分段檔亦完整.
- 手動重置:刪除紀錄檔,或`useResetGaps: true`(本次先刪**期間內各分段之範圍**並寫入,期間外之分段之範圍不動;乾跑不刪;`syncData`不透傳).`useResetGaps`只有`true`為啟用.標註後不定期重新確認.
- 測試:`api-saveDataGaps` S1~S7、S10、S14、S16、S20、S22、S24;`unit-gaps` U2~U11、C5、C6;`api-saveData` I8.

### W16 回傳與合併之成因

- `saveData`另於非空時含`failed: [{ tag, ts, te, kind, httpStatus, code, attempts, counted }]`與`gaps: [{ tag, from, to, n, state, ... }]`(期間內各段之紀錄,不只本次;期間外之分段之範圍不列);`items[].reason`另有`'pending'`;合併時兩者為基底之值.
- `readGaps(fdData, name, type, folder)`(亦掛於`WDwdataBinace()`):讀該資料夾之`_gaps.json`;不連網、不寫檔、不限期間.
- `aggregate.missing`之`'gap'`元素,於缺之基底根有紀錄或其分段本次請求失敗時另含`cause`(最嚴者:`unobserved` > `unknown` > `pending` > `nodata`)、`causes`(各成因之根數),含`pending`者另含`validCount`(最少)、`firstValid`(最早);缺之基底根全為`unknown`時不附(同1.0.61).成因:有紀錄者依其狀態,否則基底分段本次請求失敗者為`unobserved`,其餘為`unknown`.其餘`reason`之元素不變.
- 修正:基底第一段請求失敗時其目標根原被當成上市前而不列;現缺之基底根所在之分段於本次`failed`者即列入(不論該失敗是否為有效觀察,故5xx而已有`pending`紀錄者亦列入),真正上市前(未失敗)之`pending`、`nodata`照舊不列.
- 測試:`api-saveDataGaps` S1、S2、S8、S11、S13、S15、S19;`unit-gaps` C1~C4、U7;`unit-aggregateData` A1;`api-saveDataAggregate` G9、G10.

## 站點與判準總表(盤點)

| 項 | 指令 | 預期 |
|---|---|---|
| 週期表之使用 | `Grep "getIntervals\(" src` | `intervals.mjs`(定義與計畫)、`saveData.mjs`(`saveNative`取表)、`aggregateData.mjs`(取分段長) |
| 取得方式之判定 | `Grep "getIntervalPlan\(" src` | `saveData.mjs`、`syncData.mjs`、`WDwdataBinace.mjs`(匯出) |
| 舊訊息殘留 | `Grep "invalid interval\[" src test` | 0 |
| 對週期表以`in`判定 | `Grep "haskey" src` | 0 |
| 請求之站點 | `Grep "axios\." src` | 只在`requestKlines.mjs`(K線端點) |
| 重試之等待 | `Grep "timers.sleep\|delay\(" src` | `timers.sleep`只在`requestKlines.mjs`之重試;`delay(100)`只在2xx回應後 |
| 紀錄檔之讀寫 | `Grep "openGapStore\|parseGapFile\|_gaps.json\|GAP_FILE" src` | `gaps.mjs`(定義)、`saveData.mjs`(開啟、更新、重置、存檔)、`aggregateData.mjs`(只讀) |
| 舊制每段一檔之殘留 | `Grep "readSidecar\|writeSidecar\|fpGapOf\|listGaps\|\.gaps\.json" src` | 0 |
| 新選項之檢測 | `Grep "readIntOpt" src` | `opts.mjs`(定義)、`requestKlines.mjs`(執行參數,無效改用預設)、`gaps.mjs`(`noDataTimes`與`timeNoData`無效即拋) |

## 破壞性變更紀錄

- 本次(相對1.0.59):見README〈Breaking changes〉——`aggregateFrom`預設一律`'auto'`、不支援之週期鍵之訊息、無效時區之拋錯時機、`syncData`建立時即檢查.
- 重試與缺根之標註(相對1.0.61):見README〈Breaking changes〉末項——請求失敗時之重試與逾時(含公開之`downloadData`)、2xx非陣列之重試與每次各印一行、失敗訊息之格式、418/429/403與連續連線層失敗後停止、有缺根之資料夾之紀錄檔`_gaps.json`(每資料夾一個)與`'pending'`、回傳之`failed`與`gaps`、標註後不再請求、`aggregate.missing`之成因、基底第一段失敗之目標根改為列入、新選項之檢測(`noDataTimes`與`timeNoData`無效即拋,其餘無效改用預設,數字字串轉數值).
