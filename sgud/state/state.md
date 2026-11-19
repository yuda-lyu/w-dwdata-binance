# 狀態

本檔為當前已開發功能之最新狀態(現況),接續工作時先讀此檔.只記現況,過程寫入`sgud/exp/experience.md`;規則(藍圖)見`sgud/rule/rulebook.md`.

## 功能與狀態

| 功能 | 狀態 | 規則帳本 | 測試檔 |
|---|---|---|---|
| `downloadData`(下載指定區間之K線,可轉CSV) | 已完成;重試與逾時(回傳值不變) | W13 | `api-requestKlines`(K12)、`api-saveData` |
| 重試與逾時(`requestKlines`) | 已完成 | W13 | `api-requestKlines`、`api-saveDataGaps` |
| 嘗試之分類與可達之判定 | 已完成 | W14 | `api-saveDataGaps`、`api-requestKlines` |
| 暫無數據與缺根之標註(每資料夾一個紀錄檔`_gaps.json`、`readGaps`、`useResetGaps`) | 已完成;每次執行讀一次、有變動才原子寫入 | W15、W16 | `unit-gaps`、`api-saveDataGaps`(S20~S24)、`api-saveData`(I8) |
| 新選項之檢測(`noDataTimes`、`timeNoData`無效即拋;其餘無效改用預設;數字字串轉數值;`useResetGaps`只認`true`) | 已完成 | W13、W15 | `unit-gaps`(U6)、`api-requestKlines`(K11、K12)、`api-saveDataGaps`(S14、S23) |
| 與現行版之等價對拍工具(未給新選項、請求皆成功且無缺根時請求、輸出樹、console、回傳逐位相同) | 已完成;`test/tools/parity.mjs` | W12、W13 | 一次性執行(見〈最近一次驗證〉) |
| `aggregate.missing`之成因與基底第一段失敗之修正 | 已完成 | W16 | `unit-gaps`(C1~C3)、`api-saveDataGaps`(S13) |
| `checkDataComplete`(分段檔是否完整) | 已完成,未改動;新增週期鍵之名目收棒案(U9b) | — | `unit-checkDataComplete` |
| `saveData` 既有六鍵(`1m`,`5m`,`15m`,`30m`,`1hr`,`4hr`)直接下載 | 已完成;於`Asia/Taipei`與`UTC`下與1.0.59逐位相同 | W4、W9 | `api-saveData`、`api-saveDataIntervals`(T1~T7) |
| `saveData` 新增週期鍵(`3m`,`2hr`,`6hr`,`8hr`,`12hr`,`1day`,`1week`) | 已完成 | W1、W4 | `api-saveDataIntervals`(T1~T6)、`unit-intervals` |
| `opt.aggregateFrom`(`auto`預設、`none`、基底週期鍵)與`getIntervalPlan` | 已完成;預設一律`auto`(不依鍵而異) | W2、W3、W7、W10 | `unit-intervals`、`api-saveDataAggregate` |
| 依時區之界線合併(`aggregateData`) | 已完成;十進位精確加總、基底定稿判定、`aggregate.missing` | W5、W6、W8、W12 | `unit-aggregateData`、`api-saveDataAggregate`(G1~G17) |
| `syncData` | 已完成;建立時檢查週期鍵、取得方式、時區,透傳`aggregateFrom` | W11 | `api-saveDataAggregate`(G14、G17) |

## 最近一次驗證

- 日期:2026-11-19(Gitea #183 修正輪);全套`npm test`綠(見回報);版本仍為1.0.59(未改`version`、未發布、`dist/`與`docs/`未重產).
- 與1.0.59之等價對拍(一次性,不在本庫):既有六鍵×`Asia/Taipei`與`UTC`×(預設、明給`none`)× 8個步驟,請求、檔案、回傳值、console輸出逐位相同.
- 2026-11-19(Gitea #192 修正輪,提案附件套於1.0.62後依裁定調整:紀錄檔改每資料夾一個、選項檢測改依輸入檢測規格):全套181案綠(`npm test`);與1.0.62之等價對拍以本庫`test/tools/parity.mjs`執行(假交易所、假時鐘,含固定與前進式兩種時鐘):182案(13週期鍵×7時區×2種取得方式)× 2種時鐘 × 6步 + `downloadData`,共2,366步、請求11,444次、檔44,237個、console 6,602列,0處差異;方法與工具自身之變異驗證(7項變異皆判為有差異)見`sgud/exp/experience.md`.變異測試55項(重試、停止、分類、標註、清零、紀錄檔之格式與逐項檢查、原子寫入與有變動才寫、重置、選項檢測),54項被殺、1項存活為等價變異(`saveData`入口重複之`getGapOpts`,`saveNative`內同一檢查仍先於連網與建夾).版本仍為1.0.62(未改`version`、未發布、`dist/`與`docs/`未重產).
- 2026-11-19(重試與缺根,附件原樣):全套171案綠;與1.0.61之等價對拍(一次性,不在本庫,假時鐘與假交易所):全部週期鍵×多時區×取得方式×多步驟(含竄改、乾跑、前進式時鐘加`timeBudget`、跨月與跨年),未給新選項、請求皆成功且交易所無缺根時請求(含標頭)、輸出樹(檔名、內容、修改時間)、console輸出、回傳逐位相同,方法見`sgud/exp/experience.md`.

## 已知缺口與待辦

- 合併時逐列以dayjs解析時間字串;以小週期為基底自很早之`dayStart`回補時,回補未完之每輪會重讀已下載之基底(以`15m`為基底自2020年約24萬列,每輪數秒,且基底各列於該輪內全數留在記憶體,約百餘MB量級,未實測).可改以固定偏移換算、並於處理完之基底分段逐出快取(未做).
- 永久不齊之合併分段(上市日所在之分段、交易所缺棒之分段,含基底已標註缺根者)每輪皆重算並重寫(資料正確;`aggregate.segments`恆非空);回補完成且無此類分段時只重算最新段.
- 偏移之取樣為每7天一次(提案之作法),短於7天之偏移窗不會被偵測(真實時區未知有此情形).
- `syncData`之`opt.interval`給了非字串時仍靜默改用`'1m'`(既有行為,依規格K3;`saveData`則視為無效而拋錯).
- 有日光節約之時區之直接下載(如`3m`、`1hr`),回撥之一小時內時間標示會重複(既有限制,已寫入README).
- `opt.proxy`於`downloadData`被註解而未生效(既有,不在本案).
- 重試與缺根(相對1.0.61)之修改案:版本未改、未發布、`dist/`與`docs/`未重產.
- 上市前之長期間(例:小週期且`dayStart`遠早於上市):紀錄檔為每資料夾一個(`_gaps.json`),每次執行讀一次、有變動才寫;標註前每輪重抓同現行(紀錄每輪更新而重寫整檔),標註後不再請求且紀錄無變動則不寫.`1m`自2017年全為上市前之最壞情形約8萬個分段、檔約27MB(上限64MiB),讀入與逐範圍檢查之成本隨分段數線性增加(每範圍約2個時區字串解析,約數十微秒;實測數字見`sgud/exp/experience.md`).
- 紀錄檔之`interval`或`timeZone`與本次呼叫不符(直接下載者變更`timeZone`而未換`fdData`)時整檔視為無紀錄並於下次寫入時覆蓋(原有之累計丟失);同分段檔之限制,README已載.
- 有日光節約之時區之直接下載(如`1hr`、`3m`):紀錄檔之範圍須在所屬分段之請求起訖內,分段起訖為線性之牆鐘字串、跨回撥者比名目長1小時,故上界給2小時餘裕(`unit-gaps` U12);回撥重複之一小時內之根,`from`之牆鐘字串往返解析可能錯置一小時,該範圍不合格時整檔視為無紀錄而重新累計(既有之時間標示限制).
- 行程於寫暫存檔與改名之間被終止時,暫存檔`_gaps.json.<pid>.tmp`會殘留(檔名含pid,不會被其後之執行清除;不會被當成分段或紀錄,僅為雜檔).
- 紀錄檔有已標註之範圍而其`validCount`、首末相隔不符目前之`noDataTimes`、`timeNoData`時不重新檢查(使用者可事後改選項;重置見W15).
- 錯誤回應(4xx/5xx,400、403、418、429除外)只在同一K線端點於本次對別段回過2xx陣列時算有效觀察;只下載單一分段之執行(即時用途)於該段回錯誤時不計,資料留在暫無數據、下次再抓.
- 紀錄檔之`from`以分段檔之時區字串存放,有日光節約之時區之直接下載於回撥之一小時內解析可能錯置一小時或被視為不合格而重新累計(同既有之時間標示限制).
- 標註之「相隔」依主機之時鐘,主機時鐘向前跳會提早標註(時鐘倒退則不誤標).
- 同一資料夾之兩次`saveData`並行時,紀錄檔為後寫者覆蓋(少計1次,屬保守方向;寫入為原子,不會讀到半檔).
- 必要參數(`name`、`type`、`endpoint`、`symbol`)之錯誤訊息仍為舊格式`invalid name`等(未依V19改寫,不在本案).
