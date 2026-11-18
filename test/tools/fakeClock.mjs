//假時鐘: 以子類別取代全域 Date(無參數之 new Date() 與 Date.now() 取注入之時刻; 帶參數者照常), 供測試以指定之「現在」執行而不依賴真實時刻、不必等待
//於 before 安裝、after 還原(mocha 之平行執行會於同一行程依序跑多個測試檔)
let RealDate = globalThis.Date
let clock = { now: 0 }

class FakeDate extends RealDate {
    constructor(...args) {
        if (args.length === 0) {
            super(clock.now)
        }
        else {
            super(...args)
        }
    }

    static now() {
        return clock.now
    }
}

//install, 安裝並設定現在之時刻(毫秒)
let install = (ms) => {
    clock.now = ms
    globalThis.Date = FakeDate
}

//setNow, 設定現在之時刻(毫秒)
let setNow = (ms) => {
    clock.now = ms
}

//uninstall, 還原真實之 Date
let uninstall = () => {
    globalThis.Date = RealDate
}

export { RealDate, install, setNow, uninstall }
