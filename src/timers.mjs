//timers, 重試前之等待; 為可替換之物件屬性, 供測試注入(記錄等待之毫秒數而不真的等待), 套件內一律經此等待
let timers = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}


export default timers
