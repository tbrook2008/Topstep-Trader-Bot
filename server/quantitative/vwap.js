/**
 * server/quantitative/vwap.js
 * Volume Weighted Average Price (VWAP)
 * 
 * VWAP provides a measure of the true average price an asset was traded at over a specific time horizon.
 * Because crypto trades 24/7 without a "daily open" like traditional equities, 
 * we use a Rolling VWAP (Volume Weighted Moving Average) over a specific window (e.g. 24 hours = 1440 mins).
 */

function computeRollingVWAP(history, period = 1440) {
  if (history.length < period) return new Array(history.length).fill(null);

  const vwap = new Array(history.length).fill(null);

  for (let i = period - 1; i < history.length; i++) {
    let cumulativeTypicalVolume = 0;
    let cumulativeVolume = 0;

    // Calculate rolling window
    for (let j = i - period + 1; j <= i; j++) {
      const typicalPrice = (history[j].high + history[j].low + history[j].close) / 3;
      const vol = history[j].volume;

      cumulativeTypicalVolume += (typicalPrice * vol);
      cumulativeVolume += vol;
    }

    if (cumulativeVolume === 0) {
      vwap[i] = history[i].close; // Fallback
    } else {
      vwap[i] = cumulativeTypicalVolume / cumulativeVolume;
    }
  }

  return vwap;
}

/**
 * Evaluate a VWAP breakout or bounce strategy
 * @param {Array} history 
 * @returns {string} 'LONG' | 'SHORT' | 'NO_TRADE'
 */
function evaluate(history) {
  const period = 1440; // 24-hour rolling VWAP (assuming 1m bars)
  if (!history || history.length < period + 5) return 'NO_TRADE';

  const vwapLine = computeRollingVWAP(history, period);
  
  const last = history.length - 1;
  const prev = last - 1;
  const currentVWAP = vwapLine[last];
  const prevVWAP = vwapLine[prev];

  if (currentVWAP === null || prevVWAP === null) return 'NO_TRADE';

  const currentClose = history[last].close;
  const prevClose = history[prev].close;

  // Strategy: VWAP Breakout
  // If price was below VWAP, and surges above it strongly.
  if (prevClose <= prevVWAP && currentClose > currentVWAP) {
    // Confirm with volume
    const avgVol = history.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    if (history[last].volume > avgVol * 1.5) {
      return 'LONG';
    }
  }

  // Strategy: VWAP Breakdown
  if (prevClose >= prevVWAP && currentClose < currentVWAP) {
    const avgVol = history.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    if (history[last].volume > avgVol * 1.5) {
      return 'SHORT';
    }
  }

  return 'NO_TRADE';
}

module.exports = { computeRollingVWAP, evaluate };
