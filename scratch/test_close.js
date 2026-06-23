const topstepx = require('../server/execution/topstepxClient');

async function testClose() {
    await topstepx.authenticate();
    const res = await topstepx.closePosition('M2K');
    console.log("Close Result:", res);
}

testClose();
