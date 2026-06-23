const topstepClient = require('../server/execution/topstepxClient');
const axios = require('axios');
async function test() {
  await topstepClient.authenticate();
  const c = await topstepClient.getContractId('MNQ');
  const now = new Date();
  const past = new Date(now.getTime() - 100000000);
  const payload = {
      contractId: c,
      live: false,
      startTime: past.toISOString(),
      endTime: now.toISOString(),
      unit: 2,
      unitNumber: 1,
      limit: 1
  };
  const response = await axios.post(`${topstepClient.baseUrl}/History/retrieveBars`, payload, {
      headers: topstepClient._getAuthHeaders()
  });
  console.log(response.data.bars);
}
test();
