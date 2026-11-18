# 回饋

本檔記任務中發現之自有套件、全域技能、全域設定之調整與抽提提案,只增不改(處置結果另記一列,寫明承接哪一列);回饋是紀錄與提案,實際修改走各自之通報管道.

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-19 | 自有套件 | wsemi `haskey` | 以`key in obj`判定,會把`'constructor'`、`'toString'`、`'__proto__'`等原型鏈成員名當成存在之鍵;套件之使用者提供之鍵(週期鍵、列舉值)以之判定時,不存在之鍵被誤判為有效.建議改為只認自有鍵,或另提供只認自有鍵之判斷函數(本套件已改用`Object.prototype.hasOwnProperty`) | `node_modules/wsemi/src/haskey.mjs:26-27`(`return (key in obj)`);探測:舊版`saveData(..., 'constructor', ...)`回傳`{items:[]}`並建立同名資料夾 |
| 2026-11-19 | 全域技能 | 新增建議:逐項變異測試之作法 | 變異測試(逐項於複本植入單一變異、`find`須於目標檔恰出現一次、每項各自取測試鎖、`mocha --parallel --bail`以離開碼判殺死、結果寫成jsonl、複本用完即清)為重複性高且易出錯之流程(本次自寫約300行之harness;易錯處:`find`未恰一次而靜默不變異、多項共用同一複本而殘留、持單一長鎖逾15分鐘上限、變異清單與測試版本不一致).建議抽提為全域技能或`tools/`之標準工具 | 本次`tmp/wdb183/mutate.mjs`與`mutations.mjs`(暫存,已清除;作法見`sgud/exp/experience.md`) |
| 2026-11-19 | 自有套件 | w-dwdata-binance(後續) | (1)`syncData`之`opt.interval`給了非字串時仍靜默改用`'1m'`,而週期鍵決定資料口徑,依規格§11〈決定資料口徑之opt〉宜改為拋錯;(2)必要參數`name`、`type`、`endpoint`、`symbol`之錯誤訊息仍為舊格式(`invalid name`),未依V19(`invalid <名稱>: must be <種類>`)改寫.兩者皆既有行為,未在本案改動 | `src/syncData.mjs:88-91`;`src/saveData.mjs:67-86`、`src/syncData.mjs:47-66` |
| 2026-11-19 | 全域設定 | 輸入參數檢測規格§11〈決定資料口徑之opt〉 | 該段以`opt.intervalSec`為例;建議補列本類(決定資料口徑、錯置即靜默):w-dwdata-binance之`opt.aggregateFrom`(本案已實作:給了而無效即拋,`undefined`與`null`視為未給)與`syncData`之`opt.interval` | 本案主控裁定4 |
