require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const client = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true
});
async function test() {
  try {
    const bars = await client.getLatestBars(['SPY', 'QQQ']);
    console.log("Stocks:", bars);
  } catch (e) {
    console.error(e);
  }
}
test();
