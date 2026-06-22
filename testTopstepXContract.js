require('dotenv').config({ path: '/Users/tbrook/Desktop/AI Trader Prop/.env' });
const axios = require('axios');

async function testAuthAndContract() {
  try {
    const res = await axios.post('https://api.topstepx.com/api/Auth/loginKey', {
      userName: process.env.TOPSTEPX_USERNAME,
      apiKey: process.env.TOPSTEPX_API_KEY
    });
    const token = res.data.token;
    
    // search contract
    const contractRes = await axios.post('https://api.topstepx.com/api/Contract/search', {
      searchText: 'NQ',
      live: false
    }, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    console.log("Contract search result:", JSON.stringify(contractRes.data.contracts.slice(0, 1), null, 2));
    
    // search account
    const accountRes = await axios.post('https://api.topstepx.com/api/Account/search', {
      onlyActiveAccounts: true
    }, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log("Account search result:", JSON.stringify(accountRes.data.accounts.slice(0, 1), null, 2));
    
  } catch(e) {
    console.error("FAIL:", e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message);
  }
}
testAuthAndContract();
