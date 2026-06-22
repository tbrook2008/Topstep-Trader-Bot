const client = require('../server/execution/topstepxClient');

async function test() {
    await client.authenticate();
    const contractId = await client.getContractId('MNQ');
    console.log('Contract ID:', contractId);
    
    // Let's test if Contract/search returns pricing
    const axios = require('axios');
    const res = await axios.post(`${client.baseUrl}/Contract/search`, { searchText: 'MNQ' }, { headers: client._getAuthHeaders() });
    console.log('Contract Info Keys:', Object.keys(res.data.contracts[0]));
    console.log('Contract Info:', res.data.contracts[0]);
}
test();
