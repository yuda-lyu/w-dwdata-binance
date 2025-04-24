import WDwdataBinace from './src/WDwdataBinace.mjs'


function test() {

    //wdd
    let wdd = WDwdataBinace()

    //BTC
    let name = 'BTC'

    //index
    let type = 'index'

    //https://www.binance.com/zh-TC/futures/funding-history/perpetual/index
    //要用下拉選單切換至BTCUSDT永續展示與比對

    //幣安API的marketKlines
    let endpoint = 'https://www.binance.com/fapi/v1/marketKlines'

    //BTCUSDT永續溢價指數(Premium index)
    let symbol = 'pBTCUSDT'

    //p
    let p = wdd.syncData(name, type, endpoint, symbol, { useShowLog: true })

    //run
    p.run()

}
test()


//node g-pBTCUSDT.mjs
