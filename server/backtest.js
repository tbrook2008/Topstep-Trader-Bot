require('dotenv').config();

// 1. Mock the dependencies for tradeExecutor before requiring it
const alpacaClient = require('./execution/alpacaClient');
const kelly = require('./risk/kellyCriterion');
const validator = require('./risk/validator');
const tradeLogger = require('./db/tradeLogger');
const memory = require('./db/strategyMemory');
const schema = require('./db/schema');

// Override methods
alpacaClient.getAccount = async () => ({ 
  portfolioValue: 100000, 
  buyingPower: 100000, 
  tradingBlocked: false 
});
alpacaClient.getOpenPositions = async () => ([]);
alpacaClient.submitOrder = async (opts) => ({ 
  orderId: 'mock-' + Date.now(), 
  ...opts 
});

// kelly is not mocked so it uses the real position sizing logic based on our mocked $100k account
validator.runChecks = async () => ({ passed: true });
tradeLogger.logTrade = () => 'mock-trade-id';
memory.saveSetup = () => {};
schema.setState = () => {};

// 2. Ensure DRY_RUN is false so we get the executed trade metrics before require
process.env.DRY_RUN = 'false';

// 3. Now require tradeExecutor
const tradeExecutor = require('./execution/tradeExecutor');

// Config
const SYMBOLS = ['AAPL', 'SPY', 'BTC/USD', 'ETH/USD', 'SOL/USD', 'QQQ', 'MSFT', 'TSLA', 'NVDA', 'DOGE/USD', 'AVAX/USD'];
const HISTORY_LIMIT = 1500;
const DAYS_TO_FETCH = 5;

// We still need the original alpaca client methods to fetch historical data
// We can use the un-mocked getClient method.
async function fetchHistoricalData(symbol, days) {
  const client = alpacaClient.getClient();
  const start = new Date();
  start.setDate(start.getDate() - days);
  
  let bars = [];
  try {
    const isCrypto = symbol.includes('/') || symbol.endsWith('USD');
    if (isCrypto) {
      const resp = await client.getCryptoBars([symbol], {
        timeframe: '1Min',
        start: start.toISOString(),
        limit: 10000
      });
      bars = resp.get(symbol) || [];
      bars = bars.map(b => ({
        open: b.Open,
        high: b.High,
        low: b.Low,
        close: b.Close,
        volume: b.Volume,
        timestamp: b.Timestamp
      }));
    } else {
      const iter = client.getBarsV2(symbol, {
        timeframe: '1Min',
        start: start.toISOString(),
      });
      for await (const b of iter) {
        bars.push({
          open: b.OpenPrice,
          high: b.HighPrice,
          low: b.LowPrice,
          close: b.ClosePrice,
          volume: b.Volume,
          timestamp: b.Timestamp
        });
      }
    }
    return bars;
  } catch (err) {
    console.error(`Error fetching data for ${symbol}:`, err.message);
    return [];
  }
}

async function runBacktest() {
  console.log(`Starting backtest for symbols: ${SYMBOLS.join(', ')}\n`);
  
  // DRY_RUN is already set to false at the top of the file

  for (const symbol of SYMBOLS) {
    console.log(`Fetching data for ${symbol}...`);
    const data = await fetchHistoricalData(symbol, DAYS_TO_FETCH);
    console.log(`Fetched ${data.length} bars for ${symbol}.`);
    
    if (data.length < HISTORY_LIMIT) {
      console.log(`Not enough data for ${symbol}. Skipping.\n`);
      continue;
    }

    let history = [];
    let openPosition = null;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    let totalPnL = 0;

    for (let i = 0; i < data.length; i++) {
      const bar = data[i];
      history.push(bar);
      
      if (history.length > HISTORY_LIMIT) {
        history.shift();
      }

      if (history.length < HISTORY_LIMIT) continue;

      if (openPosition) {
        if (openPosition.direction === 'LONG') {
          if (bar.low <= openPosition.stopLoss) {
            losses++;
            trades++;
            totalPnL -= (openPosition.entryPrice - openPosition.stopLoss) * openPosition.qty;
            openPosition = null;
          } else if (bar.high >= openPosition.takeProfit) {
            wins++;
            trades++;
            totalPnL += (openPosition.takeProfit - openPosition.entryPrice) * openPosition.qty;
            openPosition = null;
          }
        } else if (openPosition.direction === 'SHORT') {
          if (bar.high >= openPosition.stopLoss) {
            losses++;
            trades++;
            totalPnL -= (openPosition.stopLoss - openPosition.entryPrice) * openPosition.qty;
            openPosition = null;
          } else if (bar.low <= openPosition.takeProfit) {
            wins++;
            trades++;
            totalPnL += (openPosition.entryPrice - openPosition.takeProfit) * openPosition.qty;
            openPosition = null;
          }
        }
        continue;
      }

      // Simulate trade execution
      const bundle = {
        symbol,
        price: bar.close,
        history: [...history]
      };

      const result = await tradeExecutor.execute({ bundle });
      
      if (result && result.executed) {
        openPosition = {
          direction: result.direction,
          entryPrice: result.entryPrice,
          stopLoss: result.direction === 'LONG' ? result.entryPrice - result.trailPrice : result.entryPrice + result.trailPrice,
          takeProfit: result.targetPrice,
          qty: result.qty || 1,
          timestamp: bar.timestamp
        };
      }
    }

    const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(2) : 0;
    console.log(`\n--- Results for ${symbol} ---`);
    console.log(`Total Trades: ${trades}`);
    console.log(`Wins: ${wins}, Losses: ${losses}`);
    console.log(`Win Rate: ${winRate}%`);
    console.log(`Total PnL (dollars): $${totalPnL.toFixed(4)}\n`);
  }
}

// Export for testing
module.exports = { runBacktest };

// Execute if run directly
if (require.main === module) {
  runBacktest().then(() => {
    console.log("Backtest completed.");
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
