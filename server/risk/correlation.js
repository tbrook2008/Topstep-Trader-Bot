/**
 * server/risk/correlation.js
 * Computes Pearson correlation between a proposed asset and open positions
 * to prevent portfolio concentration risk.
 */
const { barsHistory } = require('../data/dataAggregator');
const alpacaClient = require('../execution/alpacaClient');
const logger = require('../utils/logger');

/**
 * Calculate Pearson correlation coefficient between two arrays of numbers.
 */
function calculatePearson(x, y) {
  if (x.length !== y.length || x.length === 0) return 0;
  
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  
  const sumX2 = x.reduce((a, b) => a + Math.pow(b, 2), 0);
  const sumY2 = y.reduce((a, b) => a + Math.pow(b, 2), 0);
  
  const sumXY = x.reduce((sum, val, i) => sum + (val * y[i]), 0);
  
  const numerator = (n * sumXY) - (sumX * sumY);
  const denominator = Math.sqrt(((n * sumX2) - Math.pow(sumX, 2)) * ((n * sumY2) - Math.pow(sumY, 2)));
  
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Check if the proposed symbol is highly correlated with any open positions.
 * Uses 1-minute bar returns for correlation.
 * @param {string} symbol - Proposed symbol to trade
 * @returns {Promise<boolean>} true if safe to trade, false if rejected due to high correlation
 */
async function checkCorrelation(symbol) {
  try {
    const positions = await alpacaClient.getOpenPositions();
    if (!positions || positions.length === 0) return true; // No open positions, safe to trade
    
    const candidateHistory = barsHistory[symbol];
    if (!candidateHistory || candidateHistory.length < 30) {
      logger.warn('Insufficient history for correlation check, passing by default', { symbol });
      return true;
    }
    
    // Compute percentage returns for candidate
    const candidateReturns = [];
    for (let i = 1; i < candidateHistory.length; i++) {
      candidateReturns.push((candidateHistory[i].close - candidateHistory[i - 1].close) / candidateHistory[i - 1].close);
    }
    
    for (const pos of positions) {
      // Don't check against itself
      if (pos.symbol === symbol || pos.symbol === symbol.replace('/', '')) continue;
      
      const posSymbol = pos.symbol.includes('/') ? pos.symbol : (symbol.includes('/') ? pos.symbol + '/USD' : pos.symbol);
      const posHistory = barsHistory[posSymbol] || barsHistory[pos.symbol];
      
      if (!posHistory || posHistory.length < 30) continue;
      
      // Align lengths
      const len = Math.min(candidateReturns.length, posHistory.length - 1);
      const cRet = candidateReturns.slice(-len);
      
      const posReturns = [];
      for (let i = posHistory.length - len; i < posHistory.length; i++) {
        posReturns.push((posHistory[i].close - posHistory[i - 1].close) / posHistory[i - 1].close);
      }
      
      const correlation = calculatePearson(cRet, posReturns);
      logger.info(`Correlation between ${symbol} and ${pos.symbol}: ${correlation.toFixed(2)}`);
      
      // Reject if correlation > 0.5 (Highly positive correlation)
      if (correlation > 0.5) {
        logger.warn(`Trade rejected: ${symbol} is highly correlated with open position ${pos.symbol} (${correlation.toFixed(2)})`);
        return false;
      }
    }
    
    return true;
  } catch (err) {
    logger.error('Error during correlation check', { error: err.message });
    return true; // fail open
  }
}

module.exports = { calculatePearson, checkCorrelation };
