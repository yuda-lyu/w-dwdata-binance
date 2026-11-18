import downloadData from './downloadData.mjs'
import saveData from './saveData.mjs'
import syncData from './syncData.mjs'
import getIntervalPlan from './intervals.mjs'


let WDwdataBinace = () => {
    let r = {
        downloadData,
        saveData,
        syncData,
        getIntervalPlan,
    }
    return r
}


export default WDwdataBinace
