const client = require('./server/execution/topstepxClient');
async function test() {
    try {
        const id = await client.getContractId('MNQ');
        console.log('Contract ID for MNQ:', id);
    } catch (e) {
        console.error(e);
    }
}
test();
