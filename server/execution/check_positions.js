const topstepxClient = require('./topstepxClient');
const axios = require('axios');

async function checkPositions() {
    await topstepxClient.authenticate();
    try {
        const response = await axios.post(`${topstepxClient.baseUrl}/Position/search`, {
            accountId: topstepxClient.accountId,
        }, {
            headers: topstepxClient._getAuthHeaders()
        });
        
        console.log('Open Positions:');
        if (response.data && response.data.positions) {
            console.log(JSON.stringify(response.data.positions, null, 2));
        } else {
            console.log(response.data);
        }
    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
    }
    process.exit(0);
}

checkPositions();
