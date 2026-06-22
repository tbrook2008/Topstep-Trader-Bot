require('dotenv').config();
const { aggregate, isCryptoSymbol } = require('../data/dataAggregator');
const { execute }      = require('../execution/tradeExecutor');
const alpacaClient     = require('../execution/alpacaClient');
const { logDecision }  = require('../db/tradeLogger');
const killSwitch       = require('../risk/killSwitch');
const logger           = require('../utils/logger');
const { checkCorrelation } = require('../risk/correlation');

const SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM', 'GLD', 'TLT'];

const tickBuffer = {};

let isPolling = false;
const lastBarTimestamps = {};

function startStream() {
  if (isPolling) return;
  isPolling = true;
  logger.info('Starting REST polling for market data to avoid WebSocket limits...');

  // Poll every 60 seconds (since we only care about 1m/5m bars)
  setInterval(pollMarketData, 60 * 1000);
  
  // Also run immediately
  pollMarketData();
}

async function pollMarketData() {
  try {
    const client = alpacaClient.getClient();
    
    // 1. Stocks
    const stocks = SYMBOLS.filter(s => !isCryptoSymbol(s));
    if (stocks.length > 0) {
      const latestBars = await client.getLatestBars(stocks);
      for (const symbol of stocks) {
        const bar = latestBars.get(symbol) || latestBars[symbol];
        if (bar) {
          const timestamp = bar.Timestamp;
          if (!lastBarTimestamps[symbol] || new Date(timestamp) > new Date(lastBarTimestamps[symbol])) {
            lastBarTimestamps[symbol] = timestamp;
            logger.info(`Fetched new 1-min stock bar for ${symbol}`, { close: bar.ClosePrice, volume: bar.Volume });
            const formattedBar = {
              open: bar.OpenPrice, high: bar.HighPrice, low: bar.LowPrice, close: bar.ClosePrice, volume: bar.Volume
            };
            await processSymbol(symbol, formattedBar);
          }
        }
      }
    }

    // 2. Crypto
    const cryptos = SYMBOLS.filter(s => isCryptoSymbol(s));
    if (cryptos.length > 0) {
      const latestCryptoBars = await client.getCryptoLatestBars(cryptos);
      for (const symbol of cryptos) {
         const bar = latestCryptoBars.get(symbol) || latestCryptoBars[symbol];
         if (bar) {
           const timestamp = bar.Timestamp;
           if (!lastBarTimestamps[symbol] || new Date(timestamp) > new Date(lastBarTimestamps[symbol])) {
             lastBarTimestamps[symbol] = timestamp;
             logger.info(`Fetched new 1-min crypto bar for ${symbol}`, { close: bar.Close || bar.ClosePrice, volume: bar.Volume });
             const formattedBar = {
                open: bar.Open || bar.OpenPrice, 
                high: bar.High || bar.HighPrice, 
                low: bar.Low || bar.LowPrice, 
                close: bar.Close || bar.ClosePrice, 
                volume: bar.Volume
             };
             await processSymbol(symbol, formattedBar);
           }
         }
      }
    }
  } catch (error) {
    logger.error('Error polling market data:', { error: error.message || error });
  }
}

async function processSymbol(symbol, latestBar) {
  try {
    if (killSwitch.isActive()) return;

    // Session time filter (EST) - Futures open at 18:00 (6:00 PM ET) and close at 16:10 (4:10 PM ET)
    const now = new Date();
    const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const timeVal = nyTime.getHours() * 100 + nyTime.getMinutes();
    
    // Allow: 18:00 to 23:59 AND 00:00 to 16:00
    if (timeVal >= 1600 && timeVal < 1800) {
      return; // Settlement window halt
    }

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
