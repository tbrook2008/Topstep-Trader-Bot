/**
 * server/quantitative/atr.js
 * Average True Range Calculation
 */

function calculateATR(history, period = 14) {
  if (!history || history.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < history.length; i++) {
    const currentHigh = history[i].high;
    const currentLow = history[i].low;
    const prevClose = history[i - 1].close;

    const tr1 = currentHigh - currentLow;
    const tr2 = Math.abs(currentHigh - prevClose);
    const tr3 = Math.abs(currentLow - prevClose);
    const tr = Math.max(tr1, tr2, tr3);
    trueRanges.push(tr);
  }

  // Calculate the first ATR as simple average of first 'period' TRs
  let atr = trueRanges.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  // Smoothed ATR for the remaining periods
  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }

  return atr;
}

function getDynamicATRMultiplier(history, baseMultiplier) {
  if (!history || history.length < 10) return baseMultiplier;
  
  // Calculate percentage returns
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    returns.push((history[i].close - history[i-1].close) / history[i-1].close);
  }
  
  const mean = returns.reduce((sum, val) => sum + val, 0) / returns.length;
  const variance = returns.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  // Assume baseline volatility of ~0.005 (0.5% per minute/period)
  // Might be smaller, let's say 0.002
  const baselineVol = 0.002;
  
  // Ratio of current vol to baseline vol
  let volRatio = stdDev / baselineVol;
  
  // Cap the ratio between 0.5 (half base multiplier) and 2.0 (double base multiplier)
  volRatio = Math.max(0.5, Math.min(volRatio, 2.0));
  
  return baseMultiplier * volRatio;
}

module.exports = { calculateATR, getDynamicATRMultiplier };
