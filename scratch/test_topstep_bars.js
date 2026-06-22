const axios = require('axios');
const client = require('../server/execution/topstepxClient');

async function testBars() {
    await client.authenticate();
    const contractId = await client.getContractId('MNQ');
    
    console.log(`Contract ID for MNQ: ${contractId}`);
    
    // We want to fetch 1m bars. We don't know the exact payload for retrieveBars, let's guess based on typical structures.
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
    const payload = {
        contractId: contractId,
        live: false,
        startTime: past.toISOString(),
        endTime: now.toISOString(),
        unit: 2, 
        unitNumber: 1,
        limit: 5
    };
    
    try {
        const res = await axios.post(`${client.baseUrl}/History/retrieveBars`, payload, {
            headers: client._getAuthHeaders()
        });
        console.log('Success!', res.data);
    } catch (e) {
        console.error('Error fetching bars:', e.response ? e.response.data : e.message);
    }
}
testBars();
