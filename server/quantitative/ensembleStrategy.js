const fs = require('fs');
const path = require('path');
const { calculateATR } = require('./atr');

let symbolParamsCache = null;
function getSymbolParams(symbol) {
  if (global.OPTIMIZE_PARAMS) return global.OPTIMIZE_PARAMS;
  if (!symbolParamsCache) {
    try {
      const p = path.join(__dirname, '../data/symbolParams.json');
      if (fs.existsSync(p)) symbolParamsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      else symbolParamsCache = {};
    } catch (e) { symbolParamsCache = {}; }
  }
  return symbolParamsCache[symbol] || {};
}

/**
 * Calculate Exponential Moving Average (EMA)
 */
function calculateEMA(candles, period = 200) {
    if (candles.length < period) return null;
    let k = 2 / (period + 1);
    let ema = candles[0].close;
    for (let i = 1; i < candles.length; i++) {
        ema = (candles[i].close * k) + (ema * (1 - k));
    }
    return ema;
}

/**
 * Calculate Donchian Channels (Highest High, Lowest Low over N periods)
 */
function calculateDonchian(candles, period = 20) {
    if (candles.length < period) return null;
    const recent = candles.slice(-period);
    const highest = Math.max(...recent.map(c => c.high));
    const lowest = Math.min(...recent.map(c => c.low));
    return { highest, lowest };
}

/**
 * Evaluates a CTA-style Trend Following strategy (Donchian Channel Breakout + EMA alignment).
 * Uses 5m for trend and 1m for entries.
 * @param {Array} history - 1m candles
 * @param {Array} history5m - 5m candles
 * @param {string} symbol - The asset symbol (for parameter lookup)
 */
function evaluate(history, history5m, symbol = 'DEFAULT') {
    if (!history || history.length < 50 || !history5m || history5m.length < 50) return null;

    const params = getSymbolParams(symbol);
    const donchianPeriod = params.donchianPeriod || 20;
    const emaPeriod = params.emaPeriod || 50;
    const stopMultiplier = params.stopMultiplier || 1.5;
    const targetMultiplier = params.targetMultiplier || 3.0;

    const current1m = history[history.length - 1];
    const prev1m = history[history.length - 2];
    
    // 1. MACRO TREND ALIGNMENT (50 EMA on 5m)
    const ema50_5m = calculateEMA(history5m, emaPeriod) || calculateEMA(history5m, history5m.length - 1);
    
    if (!ema50_5m) return null;

    // 2. ENTRY TRIGGER (20-period Donchian Channel on 1m)
    const donchian = calculateDonchian(history.slice(0, -1), donchianPeriod);
    if (!donchian) return null;

    let action = null;

    if (current1m.close > donchian.highest && current1m.close > ema50_5m) {
        action = 'LONG';
    }
    else if (current1m.close < donchian.lowest && current1m.close < ema50_5m) {
        action = 'SHORT';
    }

    if (!action) return null;

    const atr = calculateATR(history, 14);
    if (!atr || atr <= 0) return null;
    
    const stopDistance = atr * stopMultiplier;
    const targetDistance = atr * targetMultiplier;

    const stopLoss = action === 'LONG' ? current1m.close - stopDistance : current1m.close + stopDistance;
    const target = action === 'LONG' ? current1m.close + targetDistance : current1m.close - targetDistance;

    return {
        action,
        strategy: 'CTA Trend Following (Donchian+EMA)',
        confidence: 0.8,
        stopLoss,
        target,
        trailPrice: stopDistance,
        targetDist: targetDistance,
        metadata: {
            ema50_5m,
            donchianHigh: donchian.highest,
            donchianLow: donchian.lowest,
            atr
        }
    };
}

module.exports = { evaluate };
