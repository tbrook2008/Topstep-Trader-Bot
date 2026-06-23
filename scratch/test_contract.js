require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const topstepClient = require('../server/execution/topstepxClient');

async function run() {
  await topstepClient.authenticate();
  const id = await topstepClient.getContractId('MNQ');
  console.log('Got ID:', id);
}

run().catch(console.error);
