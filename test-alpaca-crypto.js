const alpaca = require('./server/execution/alpacaClient');

async function test() {
  try {
    const order = await alpaca.submitOrder({
      symbol: 'SHIB/USD',
      qty: 1,
      side: 'buy',
      trailPrice: 1.5,
    });
    console.log("Success:", order);
  } catch (err) {
    console.error("Error submitting order:");
    if (err.response && err.response.data) {
      console.error(err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

test();
