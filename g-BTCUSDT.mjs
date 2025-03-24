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
    let p = wdd.syncData(name, type, endpoint, symbol, { useShowLog: true })

    //run
    p.run()

}
test()
//get BTC price ts[2020-01-02T11:00:00] -> te[2020-01-02T11:59:59] downloading...
//get BTC price ts[2020-01-02T11:00:00] -> te[2020-01-02T11:59:59] finish
//get BTC price ts[2020-01-02T12:00:00] -> te[2020-01-02T12:59:59] downloading...
//get BTC price ts[2020-01-02T12:00:00] -> te[2020-01-02T12:59:59] finish
//get BTC price ts[2020-01-02T13:00:00] -> te[2020-01-02T13:59:59] downloading...
//continuing...


//node --experimental-modules g-BTCUSDT.mjs
