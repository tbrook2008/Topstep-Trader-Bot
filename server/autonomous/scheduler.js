require('dotenv').config();
const { startStream } = require('./loop');
const { monitorRisk } = require('./riskMonitor');
const { initDb }  = require('../db/schema');
const logger      = require('../utils/logger');

async function start() {
  logger.info('🚀 AI Trader Event-Driven Stream starting');
  logger.info(`💰 Mode: ${(process.env.TRADING_MODE || 'paper').toUpperCase()}`);
  logger.info(`👁️  Watching: ${process.env.WATCHED_SYMBOLS || 'BTC/USD,ETH/USD,AAPL'}`);

  // Initialize DB on startup
  initDb();

  // Start the Alpaca WebSocket stream
  startStream();

  // 1-Minute Crypto Risk Monitor via simple interval instead of cron
  setInterval(async () => {
    try {
      await monitorRisk();
    } catch (err) {
      logger.error('Risk Monitor cycle error', { error: err.message });
    }
  }, 60000);

  logger.info('Stream running. Press Ctrl+C to stop.');
}

// Graceful shutdown
process.on('SIGINT',  () => { logger.info('Stream stopped (SIGINT)');  process.exit(0); });
process.on('SIGTERM', () => { logger.info('Stream stopped (SIGTERM)'); process.exit(0); });

start();
