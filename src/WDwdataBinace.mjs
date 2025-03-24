import downloadData from './downloadData.mjs'
import saveData from './saveData.mjs'
import syncData from './syncData.mjs'


let WDwdataBinace = () => {
    let r = {
        downloadData,
        saveData,
        syncData,
    }
    return r
}


export default WDwdataBinace
