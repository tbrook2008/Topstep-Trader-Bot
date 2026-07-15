/**
 * server/quantitative/hybridStrategy.js
 * 
 * Regime-Aware Hybrid Strategy
 * ============================================================
 * Uses Hurst Exponent to classify the market regime, then routes
 * to the correct signal generator:
 * 
 *   H > 0.55 → TRENDING   → MACD crossover + ADX + volume
 *   H < 0.45 → RANGING    → VWAP mean reversion (existing, tightened)
 *   0.45–0.55 → CHOP      → No trade (avoid random noise)
 * 
 * Returns a signal object matching the vwapReversion.evaluate() shape,
 * so tradeExecutor.js can use it without modification.
 */

const { calculateHurst }  = require('./hurst');
const { computeADX }      = require('./adx');
const { computeEMA }      = require('./macd');
const { calculateATR }    = require('./atr');
const vwapReversion       = require('./vwapReversion');
const fs   = require('fs');
const path = require('path');

// ─── Parameter loader (honours global.OPTIMIZE_PARAMS for backtest sweeps) ──

let _paramsCache = null;
function getParams(symbol) {
  if (global.OPTIMIZE_PARAMS) return global.OPTIMIZE_PARAMS;
  if (!_paramsCache) {
    try {
      const p = path.join(__dirname, '../data/symbolParams.json');
      _paramsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) { _paramsCache = {}; }
  }
  return _paramsCache[symbol] || {};
}

// ─── Regime classifier ────────────────────────────────────────────────────────

/**
 * Classifies the current market regime.
 * @param {Array} history - OHLCV bars
 * @returns {'trending'|'ranging'|'chop'}
 */
function classifyRegime(history) {
  if (!history || history.length < 50) return 'chop';
  const H = calculateHurst(history);
  if (H > 0.55) return 'trending';
  if (H < 0.45) return 'ranging';
  return 'chop';
}

// ─── MACD Trend signal ───────────────────────────────────────────────────────

/**
 * Trend-following signal using MACD crossover gated by ADX.
 * R:R = 2:1 (TP = 2× ATR, SL = 1× ATR)
 * 
 * @param {Array} history - OHLCV bars (1-min)
 * @param {string} symbol
 * @returns {Object|null} signal or null
 */
function trendSignal(history, symbol) {
  if (!history || history.length < 60) return null;

  const params     = getParams(symbol);
  const adxThresh  = params.adxThreshold    || 22;
  const slMult     = params.trendSlMult     || 1.0;
  const tpMult     = params.trendTpMult     || 2.0;
  const volMult    = params.minVolumeRatio   || 1.3;

  const closes  = history.map(b => b.close);
  const volumes = history.map(b => b.volume);
  const opens   = history.map(b => b.open);

  // MACD components
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);

  const macdLine = closes.map((_, i) =>
    (ema12[i] !== null && ema26[i] !== null) ? ema12[i] - ema26[i] : null
  );

  const validMacd = macdLine.filter(m => m !== null);
  if (validMacd.length < 9) return null;

  const signalEma  = computeEMA(validMacd, 9);
  const signalLine = new Array(closes.length - validMacd.length).fill(null).concat(signalEma);

  const last = closes.length - 1;
  const prev = last - 1;

  const curMacd  = macdLine[last];
  const curSig   = signalLine[last];
  const prevMacd = macdLine[prev];
  const prevSig  = signalLine[prev];

  if (curMacd === null || curSig === null || prevMacd === null || prevSig === null) return null;

  // ADX filter — only trade when trend has sufficient strength
  const adx = computeADX(history, 14);
  if (adx === null || adx < adxThresh) return null;

  // Volume filter
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (avgVol > 0 && volumes[last] < avgVol * volMult) return null;

  // ATR for bracket sizing
  const atr = calculateATR(history, 14);
  if (!atr || atr === 0) return null;

  const price = closes[last];
  const curHistogram  = curMacd - curSig;
  const prevHistogram = prevMacd - prevSig;
  const barBody       = closes[last] - opens[last];

  // ─── LONG: Bullish crossover ───
  if (
    prevMacd <= prevSig && curMacd > curSig &&   // crossover
    curHistogram > prevHistogram &&               // momentum accelerating
    barBody > 0                                   // green bar confirmation
  ) {
    const stopLoss  = price - slMult * atr;
    const target    = price + tpMult * atr;
    return {
      action:   'LONG',
      entry:    price,
      target,
      stopLoss,
      regime:   'trending',
      adx:      adx.toFixed(1),
      strategy: 'MACD_TREND'
    };
  }

  // ─── SHORT: Bearish crossover ───
  if (
    prevMacd >= prevSig && curMacd < curSig &&   // crossover
    curHistogram < prevHistogram &&               // momentum accelerating down
    barBody < 0                                   // red bar confirmation
  ) {
    const stopLoss  = price + slMult * atr;
    const target    = price - tpMult * atr;
    return {
      action:   'SHORT',
      entry:    price,
      target,
      stopLoss,
      regime:   'trending',
      adx:      adx.toFixed(1),
      strategy: 'MACD_TREND'
    };
  }

  return null;
}

// ─── Main evaluate() — drop-in replacement for vwapReversion.evaluate() ──────

/**
 * Evaluate the hybrid strategy for a given bar history.
 * 
 * @param {Array} history - OHLCV bar array (oldest first)
 * @param {string} symbol
 * @returns {Object|null} signal object or null
 */
function evaluate(history, symbol) {
  if (!history || history.length < 60) return null;

  const regime = classifyRegime(history);

  if (regime === 'trending') {
    return trendSignal(history, symbol);
  }

  if (regime === 'ranging') {
    // Delegate to existing VWAP reversion (already gated by RSI 30/70, 2.5σ, vol 1.5×)
    const vwapSig = vwapReversion.evaluate(history, symbol);
    if (vwapSig) {
      return { ...vwapSig, regime: 'ranging', strategy: 'VWAP_REVERSION' };
    }
    return null;
  }

  // 'chop' regime — sit on hands
  return null;
}

module.exports = { evaluate, classifyRegime, trendSignal };
