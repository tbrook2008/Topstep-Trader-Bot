/**
 * server/quantitative/ouModel.js
 * Ornstein-Uhlenbeck (OU) Process for Mean Reversion.
 * Models the spread/price predicting when it will return to its historical average.
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

function linearRegression(x, y) {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumXX += x[i] * x[i];
  }
  
  const denominator = (n * sumXX - sumX * sumX);
  if (denominator === 0) return { a: 0, b: 0 };
  
  const b = (n * sumXY - sumX * sumY) / denominator;
  const a = (sumY - b * sumX) / n;
  
  return { a, b };
}

/**
 * Calibrate the Ornstein-Uhlenbeck model using exact linear regression.
 * dx_t = theta * (mu - x_t) dt + sigma * dW_t
 */
function calibrateOU(prices) {
  const n = prices.length;
  const x = prices.slice(0, n - 1);
  const y = prices.slice(1); // y_t = x_t
  const dy = y.map((val, i) => val - x[i]); // dx_t = x_t - x_{t-1}

  // Linear regression: dx_t = a + b * x_{t-1}
  const { a, b } = linearRegression(x, dy);

  // Revert parameters
  // b = -theta * dt (assuming dt = 1) -> theta = -b
  const theta = -b;
  
  if (theta <= 0) {
    // Not mean-reverting (it's trending or a random walk)
    return null;
  }

  // a = theta * mu -> mu = a / theta
  const mu = a / theta;

  // Calculate residuals to find sigma
  let sumResidualsSq = 0;
  for (let i = 0; i < x.length; i++) {
    const predictedDy = a + b * x[i];
    const residual = dy[i] - predictedDy;
    sumResidualsSq += residual * residual;
  }
  
  const varianceEpsilon = sumResidualsSq / x.length;
  // sigma = sqrt( varianceEpsilon * 2*theta / (1 - exp(-2*theta)) )
  // For small theta, varianceEpsilon approx = sigma^2
  const sigma = Math.sqrt(varianceEpsilon);

  // Equilibrium standard deviation
  const sigmaEq = sigma / Math.sqrt(2 * theta);

  return { theta, mu, sigma, sigmaEq };
}

/**
 * Evaluates the market for a mean-reverting entry using the OU process.
 * @param {Array} history - OHLCV bars
 * @returns {string} 'LONG' | 'SHORT' | 'NO_TRADE'
 */
function evaluate(history, symbol) {
  if (!history || history.length < 100) return 'NO_TRADE';

  const symbolParams = getSymbolParams(symbol);
  const zScoreThreshold = symbolParams.zScoreThreshold || 2.0;

  const closes = history.map(b => b.close);
  // Calibrate on the last 100 bars to capture the current local regime
  const recentCloses = closes.slice(-100);
  
  const params = calibrateOU(recentCloses);
  if (!params) return 'NO_TRADE'; // Series is not mean-reverting

  const { theta, mu, sigmaEq } = params;
  
  // We want a relatively strong mean-reversion speed (theta) to avoid dead capital
  if (theta < 0.05) return 'NO_TRADE';

  const lastPrice = closes[closes.length - 1];
  
  // Calculate Z-Score deviation from the equilibrium mean
  const zScore = (lastPrice - mu) / sigmaEq;

  // Signal LONG if price is heavily discounted (oversold) and expected to revert up
  if (zScore < -zScoreThreshold) {
    // Confirm bar closed green (starting to revert)
    const lastBar = history[history.length - 1];
    if (lastBar.close > lastBar.open) {
      return 'LONG';
    }
  }

  // Signal SHORT if price is heavily overbought
  if (zScore > zScoreThreshold) {
    const lastBar = history[history.length - 1];
    if (lastBar.close < lastBar.open) {
      return 'SHORT';
    }
  }

  return 'NO_TRADE';
}

module.exports = { evaluate, calibrateOU };
