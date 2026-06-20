/**
 * server/quantitative/hmm.js
 * Simplified Hidden Markov Model / Gaussian Mixture Model for Regime Detection.
 * Identifies hidden market regimes (High Volatility vs Low Volatility) based on log-returns.
 */

function gaussianPDF(x, mean, variance) {
  if (variance <= 0) return 0;
  const coeff = 1.0 / Math.sqrt(2.0 * Math.PI * variance);
  const exponent = -Math.pow(x - mean, 2) / (2.0 * variance);
  return coeff * Math.exp(exponent);
}

/**
 * Fits a 2-state Gaussian Mixture Model using the Expectation-Maximization (EM) algorithm.
 * State 0: Low Volatility (Momentum / Trending)
 * State 1: High Volatility (Mean Reverting / Ranging)
 */
function fitGMM(returns, iterations = 10) {
  const n = returns.length;
  if (n === 0) return null;

  // Initialize parameters
  let mu0 = 0, mu1 = 0;
  let var0 = 0.00001, var1 = 0.001; // State 0 is low vol, State 1 is high vol
  let pi0 = 0.5, pi1 = 0.5;

  const responsibilities = Array(n).fill(0).map(() => [0, 0]);

  for (let iter = 0; iter < iterations; iter++) {
    // E-Step
    for (let i = 0; i < n; i++) {
      const p0 = pi0 * gaussianPDF(returns[i], mu0, var0);
      const p1 = pi1 * gaussianPDF(returns[i], mu1, var1);
      const sum = p0 + p1;
      
      if (sum === 0) {
        responsibilities[i][0] = 0.5;
        responsibilities[i][1] = 0.5;
      } else {
        responsibilities[i][0] = p0 / sum;
        responsibilities[i][1] = p1 / sum;
      }
    }

    // M-Step
    let sumGamma0 = 0, sumGamma1 = 0;
    let sumMu0 = 0, sumMu1 = 0;

    for (let i = 0; i < n; i++) {
      sumGamma0 += responsibilities[i][0];
      sumGamma1 += responsibilities[i][1];
      
      sumMu0 += responsibilities[i][0] * returns[i];
      sumMu1 += responsibilities[i][1] * returns[i];
    }

    if (sumGamma0 > 0) mu0 = sumMu0 / sumGamma0;
    if (sumGamma1 > 0) mu1 = sumMu1 / sumGamma1;

    let sumVar0 = 0, sumVar1 = 0;
    for (let i = 0; i < n; i++) {
      sumVar0 += responsibilities[i][0] * Math.pow(returns[i] - mu0, 2);
      sumVar1 += responsibilities[i][1] * Math.pow(returns[i] - mu1, 2);
    }

    if (sumGamma0 > 0) var0 = Math.max(sumVar0 / sumGamma0, 1e-8);
    if (sumGamma1 > 0) var1 = Math.max(sumVar1 / sumGamma1, 1e-8);

    pi0 = sumGamma0 / n;
    pi1 = sumGamma1 / n;
  }

  // Ensure State 0 is always the Low Volatility state
  if (var0 > var1) {
    // Swap states
    [mu0, mu1] = [mu1, mu0];
    [var0, var1] = [var1, var0];
    [pi0, pi1] = [pi1, pi0];
  }

  return { mu0, var0, pi0, mu1, var1, pi1 };
}

/**
 * Classifies the current market regime using the GMM/HMM approximation.
 * @param {Array} history - OHLCV bars
 * @returns {string} 'momentum' | 'mean-reverting'
 */
function classifyRegime(history) {
  if (!history || history.length < 50) return 'momentum'; // Default to momentum if not enough data

  const closes = history.map(b => b.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }

  // Fit the model on the last 50 returns
  const recentReturns = returns.slice(-50);
  const model = fitGMM(recentReturns, 15);

  if (!model) return 'momentum';

  // Evaluate the probability of the most recent return belonging to the high-vol state
  const lastReturn = recentReturns[recentReturns.length - 1];
  const p0 = model.pi0 * gaussianPDF(lastReturn, model.mu0, model.var0);
  const p1 = model.pi1 * gaussianPDF(lastReturn, model.mu1, model.var1);
  const sum = p0 + p1;

  if (sum === 0) return 'momentum';

  const probHighVol = p1 / sum;

  // If there is > 60% probability we are in the high volatility state, assume mean-reverting regime
  if (probHighVol > 0.6) {
    return 'mean-reverting';
  }

  // Otherwise, momentum regime (low volatility / steady trending)
  return 'momentum';
}

module.exports = { classifyRegime, fitGMM };
