import saveData from './src/saveData.mjs'


async function test() {

    //BTC
    let name = 'BTC'

    //price
    let type = 'price'

    //幣安API的klines
    let endpoint = 'https://api.binance.com/api/v3/klines'

    //BTCUSDT交易對
    let symbol = 'BTCUSDT'

    let interval = '4hr'

    saveData(name, type, endpoint, symbol, interval, {
        dayStart: '2025-04-18',
        useShowLog: true,
    })

}
test()


//node g-saveData.mjs
