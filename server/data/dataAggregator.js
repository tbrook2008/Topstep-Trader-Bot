const topstepClient = require('../execution/topstepxClient');
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
 * Prime the historical bars using TopstepX REST API
 */
async function primeHistory(symbol) {
  if (barsHistory[symbol]) return; // Already primed

  logger.info(`Priming historical bars for ${symbol} via TopstepX...`);
  
  try {
    // getLatestBars returns a single bar in the current implementation, but we can call retrieveBars directly here
    const contractId = await topstepClient.getContractId(symbol);
    if (!contractId) {
      logger.error(`Contract ID not found for ${symbol}`);
      barsHistory[symbol] = [];
      return;
    }
    
    const now = new Date();
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    const payload = {
        contractId: contractId,
        live: false,
        startTime: past.toISOString(),
        endTime: now.toISOString(),
        unit: 2, // 2 = Minute
        unitNumber: 1,
        limit: 1500
    };
    
    const axios = require('axios');
    const response = await axios.post(`${topstepClient.baseUrl}/History/retrieveBars`, payload, {
        headers: topstepClient._getAuthHeaders()
    });
    
    if (response.data && response.data.success && response.data.bars) {
      // API returns bars in reverse chronological order (newest first). We need oldest first for indicators.
      const bars = response.data.bars.reverse().map(b => ({
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v
      }));
      barsHistory[symbol] = bars;
      logger.info(`Primed ${barsHistory[symbol].length} historical bars for ${symbol}`);
    } else {
      barsHistory[symbol] = [];
    }
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
