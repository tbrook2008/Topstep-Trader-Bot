/**
 * server/quantitative/bollingerRsi.js
 * v2 — Mean-Reversion Entry Trigger with Trend Filter + Volume Confirmation
 *
 * Improvements over v1:
 * 1. 200-bar SMA trend filter — only buy in uptrend, sell in downtrend
 * 2. Bar body confirmation — entry bar must close in direction of trade
 * 3. Volume spike filter — bar volume must exceed average (liquidity check)
 * 4. RSI momentum guard — RSI must be recovering (not still falling) for LONG
 */

const TREND_PERIOD   = parseInt(process.env.TREND_FILTER_PERIOD    || '200');
const VOL_MULTIPLIER = parseFloat(process.env.VOLUME_SPIKE_MULTIPLIER || '1.0');

// ─── Utility Calculators ──────────────────────────────────────────────────────

function computeSMA(values, period) {
  const sma = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma[i] = sum / period;
  }
  return sma;
}

function computeSD(closes, sma, period) {
  const sd = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = sma[i];
    const variance = closes.slice(i - period + 1, i + 1)
      .reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    sd[i] = Math.sqrt(variance);
  }
  return sd;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(null);
  const rsi = new Array(closes.length).fill(null);

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

// ─── Main Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate whether to enter a mean-reversion trade.
 *
 * Gates (ALL must pass):
 * 1. Price at Bollinger extreme (lower/upper band)
 * 2. RSI confirming oversold/overbought
 * 3. Trend filter — long only above SMA200, short only below SMA200
 * 4. Bar body confirmation — entry candle must close in trade direction
 * 5. Volume confirmation — bar volume >= average volume
 * 6. RSI momentum guard — for LONG: RSI rising (recovering), for SHORT: RSI falling
 *
 * @param {Array} history - OHLCV bars [{open, high, low, close, volume}]
 * @param {boolean} isCrypto - Crypto cannot be shorted on Alpaca
 * @returns {string} 'LONG' | 'SHORT' | 'NO_TRADE'
 */
function evaluate(history, isCrypto = false) {
  const minBars = Math.max(TREND_PERIOD + 1, 22);
  if (!history || history.length < minBars) return 'NO_TRADE';

  const closes  = history.map(b => b.close);
  const opens   = history.map(b => b.open);
  const volumes = history.map(b => b.volume);

  // ── Indicator calculations ──
  const sma20   = computeSMA(closes, 20);
  const sd20    = computeSD(closes, sma20, 20);
  const rsi14   = computeRSI(closes, 14);
  const smaTrend = computeSMA(closes, TREND_PERIOD);

  const last = closes.length - 1;
  const prev = last - 1;

  const currentClose  = closes[last];
  const currentOpen   = opens[last];
  const currentSMA    = sma20[last];
  const currentSD     = sd20[last];
  const currentRSI    = rsi14[last];
  const prevRSI       = rsi14[prev];
  const trendSMA      = smaTrend[last];
  const currentVolume = volumes[last];

  // Bail if any indicator is still warming up
  if (currentSMA === null || currentSD === null || currentRSI === null || trendSMA === null) {
    return 'NO_TRADE';
  }

  // ── Volume filter ──
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeOK  = avgVolume === 0 || currentVolume >= avgVolume * VOL_MULTIPLIER;

  if (!volumeOK) return 'NO_TRADE';

  const upperBand = currentSMA + (1.8 * currentSD);
  const lowerBand = currentSMA - (1.8 * currentSD);

  // ── LONG signal (mean-reversion from oversold bottom) ──
  if (
    currentClose <= lowerBand &&        // 1. Price at lower Bollinger Band
    currentRSI < 32 &&                  // 2. RSI oversold (slightly loosened from 30)
    currentClose > trendSMA &&          // 3. Trend filter: price still above 200-bar SMA (uptrend)
    currentClose > currentOpen &&       // 4. Bar body: current bar closed UP (bullish confirmation)
    prevRSI !== null && currentRSI > prevRSI // 5. RSI momentum: RSI is recovering (turning up)
  ) {
    return 'LONG';
  }

  // ── SHORT signal (mean-reversion from overbought top) ──
  if (
    !isCrypto &&                        // 0. Alpaca forbids shorting crypto
    currentClose >= upperBand &&        // 1. Price at upper Bollinger Band
    currentRSI > 68 &&                  // 2. RSI overbought (slightly loosened from 70)
    currentClose < trendSMA &&          // 3. Trend filter: price still below 200-bar SMA (downtrend)
    currentClose < currentOpen &&       // 4. Bar body: current bar closed DOWN (bearish confirmation)
    prevRSI !== null && currentRSI < prevRSI // 5. RSI momentum: RSI is turning down
  ) {
    return 'SHORT';
  }

  return 'NO_TRADE';
}

module.exports = { evaluate, computeSMA, computeSD, computeRSI };
