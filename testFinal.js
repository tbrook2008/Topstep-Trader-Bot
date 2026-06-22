require('dotenv').config({ path: '/Users/tbrook/Desktop/AI Trader Prop/.env' });
const axios = require('axios');

async function testAuth() {
  try {
    const res = await axios.post('https://api.topstepx.com/api/Auth/loginKey', {
      userName: process.env.TOPSTEPX_USERNAME,
      apiKey: process.env.TOPSTEPX_API_KEY
    });
    console.log("Auth success 1:", res.data);
  } catch(e) {
    console.error("FAIL 1:", e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message);
  }
}
testAuth();
