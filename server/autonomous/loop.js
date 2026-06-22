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

function startStream() {
  const client = alpacaClient.getClient();
  const stockStream  = client.data_stream_v2;
  const cryptoStream = client.crypto_stream_v1beta3;

  // Prevent MaxListenersExceededWarning on WebSocket reconnect loops
  stockStream.setMaxListeners  && stockStream.setMaxListeners(0);
  cryptoStream.setMaxListeners && cryptoStream.setMaxListeners(0);

  stockStream.onConnect(() => {
    logger.info('Connected to Alpaca Stock WebSocket');
    const stocks = SYMBOLS.filter(s => !isCryptoSymbol(s));
    if (stocks.length > 0) stockStream.subscribeForBars(stocks);
  });

  stockStream.onStockBar(async bar => {
    const symbol = bar.Symbol || bar.S;
    logger.info(`Received 1-min stock bar for ${symbol}`, { close: bar.ClosePrice, volume: bar.Volume });
    const formattedBar = {
      open: bar.OpenPrice, high: bar.HighPrice, low: bar.LowPrice, close: bar.ClosePrice, volume: bar.Volume
    };
    await processSymbol(symbol, formattedBar);
  });
  
  cryptoStream.onConnect(() => {
    logger.info('Connected to Alpaca Crypto WebSocket');
    const cryptos = SYMBOLS.filter(s => isCryptoSymbol(s));
    if (cryptos.length > 0) cryptoStream.subscribeForBars(cryptos);
  });

  cryptoStream.onCryptoBar(async bar => {
    const symbol = bar.Symbol || bar.S;
    logger.info(`Received 1-min crypto bar for ${symbol}`, { close: bar.Close || bar.ClosePrice, volume: bar.Volume });
    const formattedBar = {
      open: bar.Open || bar.OpenPrice, 
      high: bar.High || bar.HighPrice, 
      low: bar.Low || bar.LowPrice, 
      close: bar.Close || bar.ClosePrice, 
      volume: bar.Volume
    };
    await processSymbol(symbol, formattedBar);
  });

  cryptoStream.onError(err => logger.error('Alpaca Crypto WS Error', { error: err.message || err }));
  stockStream.onError(err => logger.error('Alpaca Stock WS Error', { error: err.message || err }));

  stockStream.connect();
  cryptoStream.connect();
}

async function processSymbol(symbol, latestBar) {
  try {
    if (killSwitch.isActive()) return;

    // Session time filter (EST)
    const now = new Date();
    const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const timeVal = nyTime.getHours() * 100 + nyTime.getMinutes();
    if (!((timeVal >= 945 && timeVal <= 1130) || (timeVal >= 1330 && timeVal <= 1530))) {
      return;
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
