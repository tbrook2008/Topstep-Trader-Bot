const topstepClient = require('../server/execution/topstepxClient');

async function test() {
  await topstepClient.authenticate();
  const c = await topstepClient.getContractId('MNQ');
  const res = await topstepClient.api.post('/History/retrieveBars', {
    "contractId": c,
    "barType": "Minute",
    "barPeriod": 1,
    "barCount": 1
  });
  console.log("RAW BARS:", res.data.bars);
}
test();
