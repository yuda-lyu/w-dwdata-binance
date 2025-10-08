import WDwdataBinace from './src/WDwdataBinace.mjs'


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
    let p = wdd.syncData(name, type, endpoint, symbol, {
        dayStart: '2025-09-08',
        interval: '1hr',
        useShowLog: true,
    })

    //run
    p.run()

}
test()
// get BTC price [2025-04-18T00:00:00] -> [2025-04-19T23:59:59] downloading...
// get BTC price [2025-04-18T00:00:00] -> [2025-04-19T23:59:59] finish
// get BTC price [2025-04-20T00:00:00] -> [2025-04-21T23:59:59] downloading...
// get BTC price [2025-04-20T00:00:00] -> [2025-04-21T23:59:59] finish
// get BTC price [2025-04-22T00:00:00] -> [2025-04-23T23:59:59] downloading...
// get BTC price [2025-04-22T00:00:00] -> [2025-04-23T23:59:59] finish
// ...


//node g-BTCUSDT.mjs
