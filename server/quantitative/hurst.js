/**
 * server/quantitative/hurst.js
 * Calculates the Hurst Exponent using Rescaled Range (R/S) Analysis.
 * H < 0.45: Mean Reverting
 * 0.45 <= H <= 0.55: Random Walk (Chop)
 * H > 0.55: Trending
 */

function calculateHurst(history) {
  if (!history || history.length < 30) return 0.5; // Default to random walk if not enough data
  
  const closes = history.map(b => b.close);
  const n = closes.length;
  
  // Calculate log returns
  const returns = [];
  for (let i = 1; i < n; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  
  const N = returns.length;
  let maxLag = Math.floor(N / 2);
  if (maxLag < 10) return 0.5;

  let RS_values = [];
  let lags = [];

  for (let lag = 10; lag <= maxLag; lag += 5) {
    let rsSum = 0;
    let chunks = Math.floor(N / lag);
    if (chunks === 0) continue;

    for (let i = 0; i < chunks; i++) {
      let chunk = returns.slice(i * lag, (i + 1) * lag);
      let mean = chunk.reduce((a, b) => a + b, 0) / lag;
      
      // Calculate standard deviation
      let variance = chunk.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / lag;
      let stdDev = Math.sqrt(variance);
      if (stdDev === 0) continue;

      // Calculate mean-centered series and cumulative deviate series
      let cumulative = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      
      for (let j = 0; j < lag; j++) {
        cumulative += (chunk[j] - mean);
        if (cumulative > maxCum) maxCum = cumulative;
        if (cumulative < minCum) minCum = cumulative;
      }
      
      let R = maxCum - minCum;
      rsSum += (R / stdDev);
    }
    
    RS_values.push(Math.log(rsSum / chunks));
    lags.push(Math.log(lag));
  }

  // Linear regression to find the slope (Hurst Exponent)
  if (lags.length < 2) return 0.5;
  
  let nLags = lags.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < nLags; i++) {
    sumX += lags[i];
    sumY += RS_values[i];
    sumXY += lags[i] * RS_values[i];
    sumX2 += lags[i] * lags[i];
  }
  
  let slope = (nLags * sumXY - sumX * sumY) / (nLags * sumX2 - sumX * sumX);
  
  // Bound the Hurst Exponent between 0 and 1
  return Math.max(0, Math.min(1, slope));
}

function classifyRegime(history) {
  const H = calculateHurst(history);
  if (H > 0.55) return 'trending';
  if (H < 0.45) return 'mean-reverting';
  return 'chop';
}

module.exports = { calculateHurst, classifyRegime };
