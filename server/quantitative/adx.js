/**
 * server/quantitative/adx.js
 * Average Directional Index (ADX) Filter
 * 
 * Used to measure the strength of a trend. 
 * If ADX is low (< 20-25), the market is choppy and trend-following strategies (like MACD) should stay out.
 */

function computeADX(history, period = 14) {
  if (history.length < period * 2) return null;

  const tr = new Array(history.length).fill(0);
  const plusDM = new Array(history.length).fill(0);
  const minusDM = new Array(history.length).fill(0);

  // 1. Calculate TR, +DM, -DM
  for (let i = 1; i < history.length; i++) {
    const high = history[i].high;
    const low = history[i].low;
    const prevHigh = history[i - 1].high;
    const prevLow = history[i - 1].low;
    const prevClose = history[i - 1].close;

    const trueRange = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    tr[i] = trueRange;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    if (upMove > downMove && upMove > 0) {
      plusDM[i] = upMove;
    } else {
      plusDM[i] = 0;
    }

    if (downMove > upMove && downMove > 0) {
      minusDM[i] = downMove;
    } else {
      minusDM[i] = 0;
    }
  }

  // 2. Wilder's Smoothing for TR, +DM, -DM
  let smoothedTR = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothedPlusDM = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dx = new Array(history.length).fill(0);

  for (let i = period + 1; i < history.length; i++) {
    smoothedTR = smoothedTR - (smoothedTR / period) + tr[i];
    smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM[i];

    const plusDI = 100 * (smoothedPlusDM / smoothedTR);
    const minusDI = 100 * (smoothedMinusDM / smoothedTR);

    const diDiff = Math.abs(plusDI - minusDI);
    const diSum = plusDI + minusDI;

    dx[i] = diSum === 0 ? 0 : 100 * (diDiff / diSum);
  }

  // 3. ADX is the Smoothed Moving Average of DX
  let adx = dx.slice(period + 1, period * 2 + 1).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period * 2 + 1; i < history.length; i++) {
    adx = ((adx * (period - 1)) + dx[i]) / period;
  }

  return adx;
}

/**
 * Filter: Returns true if market is trending (ADX >= threshold)
 */
function isTrending(history, period = 14, threshold = 25) {
  const adx = computeADX(history, period);
  if (adx === null) return false;
  return adx >= threshold;
}

module.exports = { computeADX, isTrending };
