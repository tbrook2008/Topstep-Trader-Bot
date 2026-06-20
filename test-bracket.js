require('dotenv').config();
const alpaca = require('./server/execution/alpacaClient');

async function test() {
  try {
    const res = await alpaca.submitOrder({
      symbol: 'BTC/USD',
      qty: 0.0001,
      side: 'buy',
      stopPrice: 60000,
      takeProfitPrice: 90000
    });
    console.log("SUCCESS:", res);
  } catch (err) {
    console.error("FAILED:", err.message);
    if (err.response) console.error(err.response.data);
  }
}

test();
