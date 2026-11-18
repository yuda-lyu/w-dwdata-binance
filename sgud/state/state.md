# 狀態

本檔為當前已開發功能之最新狀態(現況),接續工作時先讀此檔.只記現況,過程寫入`sgud/exp/experience.md`;規則(藍圖)見`sgud/rule/rulebook.md`.

## 功能與狀態

| 功能 | 狀態 | 規則帳本 | 測試檔 |
|---|---|---|---|
| `downloadData`(下載指定區間之K線,可轉CSV) | 已完成,未改動 | — | (無獨立測試檔,由`api-saveData`間接涵蓋) |
| `checkDataComplete`(分段檔是否完整) | 已完成,未改動;新增週期鍵之名目收棒案(U9b) | — | `unit-checkDataComplete` |
| `saveData` 既有六鍵(`1m`,`5m`,`15m`,`30m`,`1hr`,`4hr`)直接下載 | 已完成;於`Asia/Taipei`與`UTC`下與1.0.59逐位相同 | W4、W9 | `api-saveData`、`api-saveDataIntervals`(T1~T7) |
| `saveData` 新增週期鍵(`3m`,`2hr`,`6hr`,`8hr`,`12hr`,`1day`,`1week`) | 已完成 | W1、W4 | `api-saveDataIntervals`(T1~T6)、`unit-intervals` |
| `opt.aggregateFrom`(`auto`預設、`none`、基底週期鍵)與`getIntervalPlan` | 已完成;預設一律`auto`(不依鍵而異) | W2、W3、W7、W10 | `unit-intervals`、`api-saveDataAggregate` |
| 依時區之界線合併(`aggregateData`) | 已完成;十進位精確加總、基底定稿判定、`aggregate.missing` | W5、W6、W8、W12 | `unit-aggregateData`、`api-saveDataAggregate`(G1~G17) |
| `syncData` | 已完成;建立時檢查週期鍵、取得方式、時區,透傳`aggregateFrom` | W11 | `api-saveDataAggregate`(G14、G17) |

## 最近一次驗證

- 日期:2026-11-19(Gitea #183 修正輪);全套`npm test`綠(見回報);版本仍為1.0.59(未改`version`、未發布、`dist/`與`docs/`未重產).
- 與1.0.59之等價對拍(一次性,不在本庫):既有六鍵×`Asia/Taipei`與`UTC`×(預設、明給`none`)× 8個步驟,請求、檔案、回傳值、console輸出逐位相同.

## 已知缺口與待辦

- 合併時逐列以dayjs解析時間字串;以小週期為基底自很早之`dayStart`回補時,回補未完之每輪會重讀已下載之基底(以`15m`為基底自2020年約24萬列,每輪數秒,且基底各列於該輪內全數留在記憶體,約百餘MB量級,未實測).可改以固定偏移換算、並於處理完之基底分段逐出快取(未做).
- 永久不齊之合併分段(上市日所在之分段、交易所缺棒之分段)每輪皆重算並重寫(資料正確;`aggregate.segments`恆非空);回補完成且無此類分段時只重算最新段.
- 偏移之取樣為每7天一次(提案之作法),短於7天之偏移窗不會被偵測(真實時區未知有此情形).
- `syncData`之`opt.interval`給了非字串時仍靜默改用`'1m'`(既有行為,依規格K3;`saveData`則視為無效而拋錯).
- 有日光節約之時區之直接下載(如`3m`、`1hr`),回撥之一小時內時間標示會重複(既有限制,已寫入README).
- `opt.proxy`於`downloadData`被註解而未生效(既有,不在本案).
- 必要參數(`name`、`type`、`endpoint`、`symbol`)之錯誤訊息仍為舊格式`invalid name`等(未依V19改寫,不在本案).
