import downloadData from './downloadData.mjs'
import saveData from './saveData.mjs'
import syncData from './syncData.mjs'
import getIntervalPlan from './intervals.mjs'
import readGaps from './gaps.mjs'


let WDwdataBinace = () => {
    let r = {
        downloadData,
        saveData,
        syncData,
        getIntervalPlan,
        readGaps,
    }
    return r
}


export default WDwdataBinace
