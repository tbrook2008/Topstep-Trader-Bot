const alpacaClient = require('../execution/alpacaClient');
const logger = require('../utils/logger');

// Local buffer of historical bars to compute indicators
const barsHistory = {};

const CRYPTO_BASES = [];

function isCryptoSymbol(symbol) {
  return symbol.includes('/') || symbol.endsWith('USD');
}

function getSearchTerm(symbol) {
  const base = symbol.split(/[-/]/)[0].toUpperCase();
  const names = {
    BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', ADA: 'Cardano',
    DOGE: 'Dogecoin', AVAX: 'Avalanche', DOT: 'Polkadot', LINK: 'Chainlink',
    LTC: 'Litecoin', XRP: 'XRP', MATIC: 'Polygon',
  };
  return names[base] || symbol;
}

/**
 * Prime the historical bars using Alpaca REST API
 */
async function primeHistory(symbol) {
  if (barsHistory[symbol]) return; // Already primed

  logger.info(`Priming historical bars for ${symbol}...`);
  const client = alpacaClient.getClient();
  const isCrypto = isCryptoSymbol(symbol);
  
  // Get bars for the last 5 days to ensure we have enough data (overcoming weekends/holidays)
  const start = new Date();
  start.setDate(start.getDate() - 5);
  
  try {
    let bars = [];
    if (isCrypto) {
      // Crypto: getCryptoBars returns Promise<Map<symbol, Bar[]>>
      // Crypto bars use PascalCase without 'Price' suffix: Close, High, Low, Open, Volume
      const resp = await client.getCryptoBars([symbol], {
        timeframe: '1Min',
        start: start.toISOString(),
        limit: 1500
      });
      bars = resp.get(symbol) || [];
      barsHistory[symbol] = bars.map(b => ({
        open:   b.Open,
        high:   b.High,
        low:    b.Low,
        close:  b.Close,
        volume: b.Volume
      }));
    } else {
      // Stocks: getBarsV2 is an async iterable, NOT a Promise
      // Stock bars use PascalCase with 'Price' suffix: ClosePrice, HighPrice etc.
      const iter = client.getBarsV2(symbol, {
        timeframe: '1Min',
        start: start.toISOString(),
        limit: 1500
      });
      for await (const b of iter) {
        bars.push({
          open:   b.OpenPrice,
          high:   b.HighPrice,
          low:    b.LowPrice,
          close:  b.ClosePrice,
          volume: b.Volume
        });
      }
      barsHistory[symbol] = bars;
    }
    logger.info(`Primed ${barsHistory[symbol].length} historical bars for ${symbol}`);
  } catch (err) {
    logger.error(`Failed to prime history for ${symbol}`, { error: err.message });
    barsHistory[symbol] = [];
  }
}

function convert1mTo5m(bars1m) {
  const bars5m = [];
  let current5m = null;
  for (let i = 0; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (!current5m) {
      current5m = { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      current5m.high = Math.max(current5m.high, b.high);
      current5m.low = Math.min(current5m.low, b.low);
      current5m.close = b.close;
      current5m.volume += b.volume;
    }
    if ((i + 1) % 5 === 0) {
      bars5m.push(current5m);
      current5m = null;
    }
  }
  if (current5m) bars5m.push(current5m);
  return bars5m;
}

/**
 * Aggregate data and append the incoming live bar.
 */
async function aggregate(symbol, latestBar) {
  // Prime history if needed
  if (!barsHistory[symbol]) {
    await primeHistory(symbol);
  }

  // Append new live bar
  barsHistory[symbol].push(latestBar);
  
  // Keep only the last 1500 bars to prevent memory leaks
  if (barsHistory[symbol].length > 1500) {
    barsHistory[symbol].shift();
  }

  const isCrypto_  = isCryptoSymbol(symbol);

  const bundle = {
    symbol,
    isCrypto: isCrypto_,
    timestamp: new Date().toISOString(),
    // Latest bar price data
    price:     latestBar.close,
    high:      latestBar.high,
    low:       latestBar.low,
    volume:    latestBar.volume,
    
    // Pass the full historical array to be used by the deterministic quantitative scripts
    history:   barsHistory[symbol],
    history5m: convert1mTo5m(barsHistory[symbol])
  };

  return bundle;
}

module.exports = { aggregate, isCryptoSymbol, getSearchTerm, barsHistory };
