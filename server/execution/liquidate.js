require('dotenv').config({ path: __dirname + '/../../.env' });
const Alpaca = require('@alpacahq/alpaca-trade-api');

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
});

async function liquidateAll() {
  try {
    console.log('Canceling all open orders...');
    await alpaca.cancelAllOrders();
    console.log('Orders canceled.');
    
    console.log('Initiating emergency liquidation of all open positions...');
    const result = await alpaca.closeAllPositions();
    console.log('Liquidation complete. Orders submitted:', JSON.stringify(result, null, 2));
    
    setTimeout(async () => {
      const account = await alpaca.getAccount();
      console.log('Current Buying Power:', account.buying_power);
      console.log('Current Portfolio Value:', account.portfolio_value);
      process.exit(0);
    }, 5000);
  } catch (err) {
    console.error('Failed to liquidate positions:', err);
    process.exit(1);
  }
}

liquidateAll();
