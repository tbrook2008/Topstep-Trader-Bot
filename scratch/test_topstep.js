const topstepx = require('../server/execution/topstepxClient');

async function test() {
    await topstepx.authenticate();
    
    const symbols = ['MNQ', 'MES', 'MYM', 'M2K'];
    for (const sym of symbols) {
        const id = await topstepx.getContractId(sym);
        console.log(`Symbol ${sym} -> Contract ID: ${id}`);
    }
}

test();
