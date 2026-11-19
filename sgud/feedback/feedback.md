# 回饋

本檔記任務中發現之自有套件、全域技能、全域設定之調整與抽提提案,只增不改(處置結果另記一列,寫明承接哪一列);回饋是紀錄與提案,實際修改走各自之通報管道.

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-19 | 自有套件 | wsemi `haskey` | 以`key in obj`判定,會把`'constructor'`、`'toString'`、`'__proto__'`等原型鏈成員名當成存在之鍵;套件之使用者提供之鍵(週期鍵、列舉值)以之判定時,不存在之鍵被誤判為有效.建議改為只認自有鍵,或另提供只認自有鍵之判斷函數(本套件已改用`Object.prototype.hasOwnProperty`) | `node_modules/wsemi/src/haskey.mjs:26-27`(`return (key in obj)`);探測:舊版`saveData(..., 'constructor', ...)`回傳`{items:[]}`並建立同名資料夾 |
| 2026-11-19 | 全域技能 | 新增建議:逐項變異測試之作法 | 變異測試(逐項於複本植入單一變異、`find`須於目標檔恰出現一次、每項各自取測試鎖、`mocha --parallel --bail`以離開碼判殺死、結果寫成jsonl、複本用完即清)為重複性高且易出錯之流程(本次自寫約300行之harness;易錯處:`find`未恰一次而靜默不變異、多項共用同一複本而殘留、持單一長鎖逾15分鐘上限、變異清單與測試版本不一致).建議抽提為全域技能或`tools/`之標準工具 | 本次`tmp/wdb183/mutate.mjs`與`mutations.mjs`(暫存,已清除;作法見`sgud/exp/experience.md`) |
| 2026-11-19 | 自有套件 | w-dwdata-binance(後續) | (1)`syncData`之`opt.interval`給了非字串時仍靜默改用`'1m'`,而週期鍵決定資料口徑,依規格§11〈決定資料口徑之opt〉宜改為拋錯;(2)必要參數`name`、`type`、`endpoint`、`symbol`之錯誤訊息仍為舊格式(`invalid name`),未依V19(`invalid <名稱>: must be <種類>`)改寫.兩者皆既有行為,未在本案改動 | `src/syncData.mjs:88-91`;`src/saveData.mjs:67-86`、`src/syncData.mjs:47-66` |
| 2026-11-19 | 全域設定 | 輸入參數檢測規格§11〈決定資料口徑之opt〉 | 該段以`opt.intervalSec`為例;建議補列本類(決定資料口徑、錯置即靜默):w-dwdata-binance之`opt.aggregateFrom`(本案已實作:給了而無效即拋,`undefined`與`null`視為未給)與`syncData`之`opt.interval` | 本案主控裁定4 |
| 2026-11-19 | 全域設定 | 輸入參數檢測規格§11〈決定資料口徑之opt〉(#192補) | 建議補列:w-dwdata-binance之`opt.noDataTimes`、`opt.timeNoData`(決定何時永久標註為缺根、之後不再抓,錯值使資料靜默缺漏,給了而無效即拋);同套件之`retryTimes`等執行參數依K3改用預設.兩類之分野(錯值是否改變資料,而非是否為數字)可寫入§11 | 本輪任務書之選項檢測裁定;`src/gaps.mjs`(`getGapOpts`)、`src/requestKlines.mjs`(`getFetchOpts`) |
| 2026-11-19 | 自有套件 | wsemi `iseint` | 判定之後之取值(`Number(v.trim())`,`-0`以0計)無對應函數,各套件自寫(本庫`src/opts.mjs`之`readIntOpt`)而易各異;建議新增與`iseint`同範圍設定、判定通過即回轉換值(無效回`NaN`或指定預設)之轉換函數 | `node_modules/wsemi/src/iseint.mjs`(`eintVal`未匯出);`src/opts.mjs` |
| 2026-11-19 | 全域設定 | 派工提示詞之「提案所附之對拍工具」 | 任務書稱以「提案所附之對拍工具或同等工具」驗證不變量,但附件(`w-dwdata-binance.patch`)只含程式、測試與文件,無對拍工具,agent 須自寫(本庫`test/tools/parity.mjs`,約300行,含變異驗證).建議提案附件須含其所稱之驗證工具,或由主控維護通用之對拍骨架(假交易所、假時鐘、輸出樹與console之比對) | 附件之19個檔(`grep '^diff -ruN'`);`test/tools/parity.mjs` |
| 2026-11-19 | 全域設定 | 主控守門hook `bash-write` 與派工守則之`nohup … > ./tmp/<名>.log` | 守則(共通守則17)教以`nohup … > ./tmp/<名>.log 2>&1 &`起背景行程,但守門hook擋一切`>`寫檔(只放行`> /dev/null`),二者相衝;本輪改以`quiet-run`(其自身寫log)加`run_in_background`達成.建議守則改寫為「長指令一律經`quiet-run`並以`run_in_background`執行」 | 本輪被擋之指令(守門訊息`[主控守門 bash-write]`) |
| 2026-11-19 | 全域技能 | `quiet-run`(工具)之工作目錄 | `quiet-run`無`--cwd`以外之工作目錄選項供執行(`--cwd`只用於`--release-stale`),於複本資料夾跑測試(變異、修前紅)須自寫外層腳本以`spawnSync(..., { cwd })`呼叫;建議`quiet-run`支援以指定資料夾為工作目錄執行 | 本輪`tmp/wdb192/runin.mjs`、`tmp/wdb192/mutate.mjs`(暫存,已清除) |
| 2026-11-19 | 全域設定 | 全域設定§8.1(Edit與Write對行尾之處理) | 本庫`src/*.mjs`與`README.md`為CRLF:Edit工具保留既有行尾,Write工具新建之檔為LF,新檔須另以腳本轉CRLF(本輪`tmp/wdb192/tocrlf.mjs`);測試檔與`sgud/`為LF.建議全域設定或技能載明「CRLF庫之新檔須轉行尾,並以`git diff --stat`確認無整檔行尾變動」 | `file src/*.mjs`(各檔行尾);Write新建之`src/opts.mjs`、`src/gaps.mjs`初為LF |
