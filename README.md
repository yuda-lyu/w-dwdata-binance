# w-dwdata-binance
A download tool for binace.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-dwdata-binance.svg?style=flat)](https://npmjs.org/package/w-dwdata-binance) 
[![license](https://img.shields.io/npm/l/w-dwdata-binance.svg?style=flat)](https://npmjs.org/package/w-dwdata-binance) 
[![npm download](https://img.shields.io/npm/dt/w-dwdata-binance.svg)](https://npmjs.org/package/w-dwdata-binance) 
[![npm download](https://img.shields.io/npm/dm/w-dwdata-binance.svg)](https://npmjs.org/package/w-dwdata-binance) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-dwdata-binance.svg)](https://www.jsdelivr.com/package/npm/w-dwdata-binance)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-dwdata-binance/global.html).

## Installation
### Using npm(ES6 module):
```alias
npm i w-dwdata-binance
```

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-dwdata-binance/blob/master/g-BTCUSDT.mjs)]
```alias
import WDwdataBinace from 'w-dwdata-binance'

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
```
