require('dotenv').config({ path: '/Users/tbrook/Desktop/AI Trader Prop/.env' });
const axios = require('axios');

async function testAuth() {
  try {
    console.log("sending loginKey with:", process.env.TOPSTEPX_USERNAME, process.env.TOPSTEPX_API_KEY);
    const res = await axios.post('https://gateway.topstepx.com/api/Auth/loginKey', {
      userName: process.env.TOPSTEPX_USERNAME,
      apiKey: process.env.TOPSTEPX_API_KEY
    });
    console.log("Auth success", res.data);
  } catch(e) {
    console.error("FAIL:", e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message);
  }
}
testAuth();
