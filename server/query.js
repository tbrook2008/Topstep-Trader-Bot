require('dotenv').config({ path: __dirname + '/../.env' });
const Alpaca = require('@alpacahq/alpaca-trade-api');

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
});

async function queryMayTrades() {
  try {
    const orders = await alpaca.getOrders({
      status: 'all',
      after: new Date('2026-05-01T00:00:00Z'),
      until: new Date('2026-05-15T00:00:00Z'),
      direction: 'asc',
      limit: 500
    });
    
    let totalPnL = 0;
    const symbolCounts = {};

    for (const order of orders) {
      if (order.status === 'filled') {
        const symbol = order.symbol;
        symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1;
      }
    }
    
    // Check portfolio history
    const history = await alpaca.getPortfolioHistory({
      timeframe: '1D',
      date_start: '2026-05-01',
      date_end: '2026-05-15',
    });

    console.log(`\n=== ALPACA MAY 2026 ANALYSIS ===`);
    console.log(`Orders Filled in early May:`, Object.entries(symbolCounts).sort((a,b) => b[1]-a[1]).slice(0, 10));
    
    if (history.equity && history.equity.length > 0) {
      console.log(`Portfolio High: $${Math.max(...history.equity)}`);
      console.log(`Portfolio Low: $${Math.min(...history.equity)}`);
    } else {
      console.log("No portfolio history found for this period.");
    }
  } catch (err) {
    console.error(err);
  }
}

queryMayTrades();
