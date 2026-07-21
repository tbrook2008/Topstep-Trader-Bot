require('dotenv').config();
const { aggregate, isCryptoSymbol } = require('../data/dataAggregator');
const { execute }      = require('../execution/tradeExecutor');
const topstepClient    = require('../execution/topstepxClient');
const { logDecision }  = require('../db/tradeLogger');
const killSwitch       = require('../risk/killSwitch');
const logger           = require('../utils/logger');
const { checkCorrelation } = require('../risk/correlation');

const SYMBOLS = ['MGC', 'MNQ'];

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
    const latestBars = await topstepClient.getLatestBars(SYMBOLS);
    for (const symbol of SYMBOLS) {
      const bar = latestBars[symbol];
      if (bar) {
        const timestamp = bar.Timestamp;
        if (!lastBarTimestamps[symbol] || new Date(timestamp) > new Date(lastBarTimestamps[symbol])) {
          lastBarTimestamps[symbol] = timestamp;
          logger.info(`Fetched new 1-min TopstepX bar for ${symbol}`, { close: bar.ClosePrice, volume: bar.Volume });
          const formattedBar = {
            open: bar.OpenPrice, high: bar.HighPrice, low: bar.LowPrice, close: bar.ClosePrice, volume: bar.Volume, time: bar.Timestamp
          };
          await processSymbol(symbol, formattedBar);
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

    // Session time filter (EST) - Futures open at 17:00 (5:00 PM ET) and close at 16:10 (4:10 PM ET)
    const now = new Date();
    const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const timeVal = nyTime.getHours() * 100 + nyTime.getMinutes();
    
    // Allow: 17:00 to 23:59 AND 00:00 to 16:00
    if (timeVal >= 1600 && timeVal < 1700) {
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
    logger.error('Unhandled error in processSymbol', { symbol, error: err.message, stack: err.stack });
  }
}

module.exports = { startStream, processSymbol };
