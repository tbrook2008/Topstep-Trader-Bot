const topstepClient = require('../server/execution/topstepxClient');
async function test() {
  const latestBars = await topstepClient.getLatestBars(['MNQ', 'MES', 'MYM', 'M2K', 'MCL', 'MGC']);
  console.log("LATEST BARS:", latestBars);
}
test();
