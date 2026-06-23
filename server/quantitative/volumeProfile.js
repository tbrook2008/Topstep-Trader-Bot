/**
 * server/quantitative/volumeProfile.js
 * NEW — Volume Profile Analysis
 *
 * Analyzes whether the current bar's volume is meaningful relative to history.
 * Used as a secondary filter in the execution pipeline to avoid trading on
 * low-liquidity periods (late night, thin markets, etc.)
 *
 * Also detects volume divergence: price making new extremes on decreasing volume
 * is a warning sign that the move lacks conviction.
 */

const fs = require('fs');
const path = require('path');
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
 * Compute a rolling volume average.
 */
function rollingAvg(volumes, period) {
  if (volumes.length < period) return null;
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Determine if current volume supports the proposed trade direction.
 *
 * @param {Array} history  - OHLCV bars [{open,high,low,close,volume}]
 * @param {string} direction - 'LONG' | 'SHORT'
 * @returns {{ supported: boolean, reason: string, ratio: number }}
 */
function analyzeVolume(history, direction, symbol) {
  if (!history || history.length < 20) {
    return { supported: true, reason: 'insufficient_history', ratio: 1 };
  }

  const params = getSymbolParams(symbol);
  const minVolumeRatio = params.minVolumeRatio || 1.5;

  const volumes  = history.map(b => b.volume);
  const closes   = history.map(b => b.close);
  const last     = history.length - 1;

  const currentVol = volumes[last];
  const avg20      = rollingAvg(volumes, 20);
  const avg5       = rollingAvg(volumes, 5);

  if (!avg20 || avg20 === 0) {
    return { supported: true, reason: 'zero_avg_volume', ratio: 1 };
  }

  const ratio = currentVol / avg20;

  // Volume divergence check: is price at extreme but volume FALLING?
  // If the last 3 bars are making new lows/highs but volume is declining, signal is weak
  const last3Vols   = volumes.slice(-3);
  const volDecreasing = last3Vols[2] < last3Vols[1] && last3Vols[1] < last3Vols[0];

  const last3Closes = closes.slice(-3);
  const priceAtLow  = last3Closes[2] <= Math.min(last3Closes[0], last3Closes[1]);
  const priceAtHigh = last3Closes[2] >= Math.max(last3Closes[0], last3Closes[1]);

  if (direction === 'LONG' && priceAtLow && volDecreasing) {
    // Price making new lows but volume shrinking = potential exhaustion (actually bullish for reversal)
    return { supported: true, reason: 'volume_exhaustion_long', ratio };
  }

  if (direction === 'SHORT' && priceAtHigh && volDecreasing) {
    return { supported: true, reason: 'volume_exhaustion_short', ratio };
  }

  // Absolute minimum: don't trade if volume is less than 1.5x of normal
  if (ratio < minVolumeRatio) {
    return { supported: false, reason: 'insufficient_momentum', ratio };
  }

  return { supported: true, reason: 'ok', ratio };
}

/**
 * Get a simple volume classification for logging.
 */
function classifyVolume(history) {
  if (!history || history.length < 20) return 'unknown';
  const volumes = history.map(b => b.volume);
  const current = volumes[volumes.length - 1];
  const avg = rollingAvg(volumes, 20);
  if (!avg || avg === 0) return 'unknown';
  const ratio = current / avg;
  if (ratio > 2.0) return 'HIGH';
  if (ratio > 1.0) return 'ABOVE_AVG';
  if (ratio > 0.5) return 'BELOW_AVG';
  return 'LOW';
}

module.exports = { analyzeVolume, classifyVolume, rollingAvg };
