require('dotenv').config();
const { aggregate, isCryptoSymbol } = require('../data/dataAggregator');
const { execute }      = require('../execution/tradeExecutor');
const alpacaClient     = require('../execution/alpacaClient');
const { logDecision, getDailyPnl }  = require('../db/tradeLogger');
const killSwitch       = require('../risk/killSwitch');
const logger           = require('../utils/logger');
const { checkCorrelation } = require('../risk/correlation');

const SYMBOLS = (process.env.WATCHED_SYMBOLS || 'BTC/USD,ETH/USD,AAPL').split(',').map(s => s.trim());

const tickBuffer = {};

function startStream() {
  const client = alpacaClient.getClient();
  const stockStream  = client.data_stream_v2;
  const cryptoStream = client.crypto_stream_v1beta3;

  // Prevent MaxListenersExceededWarning on WebSocket reconnect loops
  stockStream.setMaxListeners  && stockStream.setMaxListeners(0);
  cryptoStream.setMaxListeners && cryptoStream.setMaxListeners(0);

  logger.info('Starting REST polling instead of WebSocket to avoid connection limit conflicts.');
  
  setInterval(async () => {
    try {
      const stocks = SYMBOLS.filter(s => !isCryptoSymbol(s));
      const cryptos = SYMBOLS.filter(s => isCryptoSymbol(s));

      if (stocks.length > 0) {
        const bars = await client.getLatestBars(stocks);
        for (const symbol of stocks) {
          if (bars.has(symbol)) {
            const b = bars.get(symbol);
            const formattedBar = {
              open: b.OpenPrice, high: b.HighPrice, low: b.LowPrice, close: b.ClosePrice, volume: b.Volume
            };
            logger.info(`Received REST 1-min stock bar for ${symbol}`, { close: formattedBar.close, volume: formattedBar.volume });
            await processSymbol(symbol, formattedBar);
          }
        }
      }

      if (cryptos.length > 0) {
        const bars = await client.getLatestCryptoBars(cryptos);
        for (const symbol of cryptos) {
          if (bars.has(symbol)) {
            const b = bars.get(symbol);
            const formattedBar = {
              open: b.Open, high: b.High, low: b.Low, close: b.Close, volume: b.Volume
            };
            logger.info(`Received REST 1-min crypto bar for ${symbol}`, { close: formattedBar.close, volume: formattedBar.volume });
            await processSymbol(symbol, formattedBar);
          }
        }
      }
    } catch (err) {
      logger.error('REST Polling Error', { error: err.message });
    }
  }, 60000); // Poll every 60 seconds
}

async function processSymbol(symbol, latestBar) {
  try {
    // Topstep Time Constraint: NY Volatility Window only
    const now = new Date();
    const options = { timeZone: 'America/Chicago', hour12: false, hour: 'numeric', minute: 'numeric' };
    const ctTime = new Intl.DateTimeFormat('en-US', options).format(now);
    const [ctHour, ctMinute] = ctTime.split(':').map(Number);
    const timeInMinutes = ctHour * 60 + ctMinute;

    // Topstep no-trade zone: 3:00 PM CT (900 mins) to 5:00 PM CT (1020 mins)
    if (timeInMinutes >= 900 && timeInMinutes < 1020) {
      return; // Silently skip if during maintenance window
    }

    // Auto-check Daily PnL Limits (Profit Cap and Loss Limit)
    killSwitch.autoCheckDailyLimits(getDailyPnl());

    if (killSwitch.isActive()) return;

    // 1. Aggregate market data
    const bundle = await aggregate(symbol, latestBar);
    if (!bundle) return;

    // 2. Correlation Check
    const correlationPass = await checkCorrelation(symbol);
    if (!correlationPass) {
      logger.info('Trade rejected due to high correlation with open positions', { symbol });
      return;
    }

    // 3. Execute purely based on math logic
    await execute({ bundle });

  } catch (err) {
    logger.error('Unhandled error in processSymbol', { symbol, error: err.message });
  }
}

module.exports = { startStream, processSymbol };
