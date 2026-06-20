require('dotenv').config();
const { getWinStats } = require('../db/strategyMemory');
const logger = require('../utils/logger');

const KELLY_DIVISOR  = parseFloat(process.env.KELLY_FRACTION_DIVISOR || '4');
const MIN_FRACTION   = parseFloat(process.env.MIN_KELLY_FRACTION     || '0.005');
const MAX_FRACTION   = parseFloat(process.env.MAX_KELLY_FRACTION     || '0.15');

/**
 * Apply Platt scaling to calibrate raw AI confidence (0-100) into a probability.
 * P = 1 / (1 + exp(-A * x + B))
 * We want 50 -> ~0.5, 75 -> ~0.65, 90 -> ~0.8
 */
function calibrateConfidence(confidence) {
  if (!confidence) return 0.5;
  const x = confidence / 100; // normalize to 0-1
  const A = 5.0;
  const B = 2.5;
  const prob = 1 / (1 + Math.exp(-(A * x - B)));
  return prob;
}

/**
 * Full Kelly formula: K = (p * b - q) / b
 * where p = win rate, q = 1-p, b = avg_win / avg_loss (profit factor)
 * Fractional Kelly = K / KELLY_DIVISOR
 *
 * @param {{ winRate, avgWin, avgLoss, balance, aiConfidence }} params
 * @returns {{ fraction, positionSize, dollarRisk }}
 */
function calculate({ winRate, avgWin, avgLoss, balance, aiConfidence }) {
  // Calibrate the AI confidence
  const aiProb = calibrateConfidence(aiConfidence);
  
  // Blend historical win rate with AI probability (if we have history)
  // If no history, just use the AI probability as the win rate assumption.
  const p = winRate && winRate > 0 ? (winRate * 0.5 + aiProb * 0.5) : aiProb;

  // Default R/R if no history
  const b = (avgWin && avgLoss && avgLoss > 0) ? (avgWin / avgLoss) : 1.5; 

  const q = 1 - p;
  const kelly = (p * b - q) / b; // full Kelly fraction

  if (kelly <= 0) {
    logger.warn('Kelly <= 0 — using minimum fraction', { p, b, aiConfidence });
    return { fraction: MIN_FRACTION, positionSize: balance * MIN_FRACTION, dollarRisk: balance * MIN_FRACTION };
  }

  const fractional = kelly / KELLY_DIVISOR;
  const clamped    = Math.max(MIN_FRACTION, Math.min(MAX_FRACTION, fractional));
  const positionSize = parseFloat((balance * clamped).toFixed(2));

  logger.info('Kelly sizing', {
    calibratedProb: (p * 100).toFixed(1) + '%',
    profitFactor:   b.toFixed(2),
    fullKelly:      (kelly * 100).toFixed(2) + '%',
    fractionalKelly:(fractional * 100).toFixed(2) + '%',
    clampedFraction:(clamped * 100).toFixed(2) + '%',
    positionSize,
  });

  return { fraction: clamped, positionSize, dollarRisk: positionSize };
}

/**
 * Calculate shares/units to buy given position dollar size and current price.
 */
function calculateQty(positionDollars, price) {
  if (!price || price <= 0) return 0;
  // For stocks we need integer qty. Crypto can use float. 
  // We'll let the Alpaca client handle formatting; return float here.
  return parseFloat((positionDollars / price).toFixed(6));
}

/**
 * Get position size for a symbol using strategy memory stats.
 * @param {string} symbol
 * @param {number} currentPrice
 * @param {number|null} liveBalance  Pass the real Alpaca portfolio_value. Falls back to env if omitted.
 * @param {number} aiConfidence      The composite confidence score from the AI consensus
 */
function getPositionSize(symbol, currentPrice, liveBalance = null, aiConfidence = 50, buyingPower = null) {
  // Prefer the live balance passed in from tradeExecutor (fetched from Alpaca API)
  const isLive = (process.env.TRADING_MODE || 'paper') === 'live';
  const balance = liveBalance ?? (isLive
    ? parseFloat(process.env.LIVE_ACCOUNT_BALANCE  || '5000')
    : parseFloat(process.env.PAPER_ACCOUNT_BALANCE || '100000'));

  const maxPct = parseFloat(process.env.MAX_POSITION_PCT || '0.10');
  const maxPosition = balance * maxPct;

  const stats = getWinStats(symbol) || {};
  const { fraction, positionSize } = calculate({
    winRate: stats.winRate,
    avgWin:  stats.avgWin,
    avgLoss: stats.avgLoss,
    balance,
    aiConfidence,
  });

  let finalSize = Math.min(Math.max(positionSize, 10), maxPosition);

  // If buying power is specified, cap finalSize to buyingPower (minus 5% for slippage padding)
  if (buyingPower !== null && finalSize > buyingPower * 0.95) {
    if (buyingPower < 10.5) {
      finalSize = 0; // cannot even satisfy the $10 minimum
    } else {
      finalSize = buyingPower * 0.95;
    }
  }

  const qty = calculateQty(finalSize, currentPrice);

  return {
    balance,
    fraction,
    positionDollars: finalSize,
    qty,
    stats,
  };
}

module.exports = { calculate, calculateQty, getPositionSize, calibrateConfidence };
