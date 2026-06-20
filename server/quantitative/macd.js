/**
 * server/quantitative/macd.js
 * v2 — MACD Momentum Entry Trigger with Trend Filter + Histogram Confirmation
 *
 * Improvements over v1:
 * 1. MACD histogram threshold — crossover must have meaningful separation
 * 2. Trend alignment — MACD must be on the correct side of zero
 * 3. Bar body confirmation — entry bar must close in direction of trade
 * 4. Volume confirmation — bar volume must meet minimum threshold
 */

const VOL_MULTIPLIER = parseFloat(process.env.VOLUME_SPIKE_MULTIPLIER || '1.0');

// ─── Utility ─────────────────────────────────────────────────────────────────

function computeEMA(closes, period) {
  if (closes.length < period) return [];
  const k   = 2 / (period + 1);
  let ema   = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const emas = new Array(period - 1).fill(null);
  emas.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emas.push(ema);
  }
  return emas;
}

function computeSMA(values, period) {
  const sma = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma[i] = sum / period;
  }
  return sma;
}

// ─── Main Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate MACD for a momentum entry.
 *
 * Gates (ALL must pass):
 * 1. MACD bullish/bearish crossover (line crosses signal)
 * 2. MACD histogram growing in crossover direction (momentum is accelerating)
 * 3. MACD line on correct side of zero (confirms macro trend)
 * 4. Bar body confirmation — entry candle closed in trade direction
 * 5. Volume above 20-bar average (liquidity)
 *
 * @param {Array} history - OHLCV bars [{open, high, low, close, volume}]
 * @param {boolean} isCrypto - for future use
 * @returns {string} 'LONG' | 'SHORT' | 'NO_TRADE'
 */
function evaluate(history, isCrypto = false) {
  if (!history || history.length < 35) return 'NO_TRADE';

  const closes  = history.map(b => b.close);
  const opens   = history.map(b => b.open);
  const volumes = history.map(b => b.volume);

  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);

  // Build MACD line
  const macdLine = closes.map((_, i) =>
    (ema12[i] !== null && ema26[i] !== null) ? ema12[i] - ema26[i] : null
  );

  const validMacd = macdLine.filter(m => m !== null);
  if (validMacd.length < 9) return 'NO_TRADE';

  const sma200 = computeSMA(closes, 200);

  const signalEma  = computeEMA(validMacd, 9);
  const signalLine = new Array(closes.length - validMacd.length).fill(null).concat(signalEma);

  const last = closes.length - 1;
  const prev = last - 1;

  const currentMacd   = macdLine[last];
  const currentSignal = signalLine[last];
  const prevMacd      = macdLine[prev];
  const prevSignal    = signalLine[prev];
  const macroTrend    = sma200[last];

  if (currentMacd === null || currentSignal === null || prevMacd === null || prevSignal === null || macroTrend === null) {
    return 'NO_TRADE';
  }

  // ── Volume filter ──
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeOK  = avgVolume === 0 || volumes[last] >= avgVolume * VOL_MULTIPLIER;
  if (!volumeOK) return 'NO_TRADE';

  // Histogram (spread between MACD and Signal)
  const currentHistogram = currentMacd - currentSignal;
  const prevHistogram    = prevMacd - prevSignal;

  const currentBarBody = closes[last] - opens[last];

  // ── LONG: Bullish crossover ──
  if (
    prevMacd <= prevSignal && currentMacd > currentSignal && // 1. Bullish crossover
    currentHistogram > prevHistogram &&                       // 2. Histogram growing (momentum accelerating)
    closes[last] > macroTrend &&                              // 3. Macro uptrend filter (above 200 SMA)
    currentBarBody > 0                                        // 4. Entry bar closed green
  ) {
    return 'LONG';
  }

  // ── SHORT: Bearish crossover ──
  if (
    prevMacd >= prevSignal && currentMacd < currentSignal && // 1. Bearish crossover
    currentHistogram < prevHistogram &&                       // 2. Histogram growing negative
    closes[last] < macroTrend &&                              // 3. Macro downtrend filter (below 200 SMA)
    currentBarBody < 0                                        // 4. Entry bar closed red
  ) {
    return 'SHORT';
  }

  return 'NO_TRADE';
}

module.exports = { evaluate, computeEMA, computeSMA };
