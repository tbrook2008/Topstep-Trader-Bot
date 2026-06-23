const topstepx = require('../server/execution/topstepxClient');
const axios = require('axios');

async function test() {
    await topstepx.authenticate();
    
    // Let's try to query working orders
    try {
        const response = await axios.post(`${topstepx.baseUrl}/Order/search`, {
            accountId: topstepx.accountId,
            onlyWorking: true,
            startTimestamp: new Date(Date.now() - 24*60*60*1000).toISOString(),
            endTimestamp: new Date().toISOString()
        }, {
            headers: topstepx._getAuthHeaders()
        });
        console.log("Orders:", response.data);
    } catch (err) {
        console.error("Order search error:", err.response ? err.response.data : err.message);
    }
}

test();
