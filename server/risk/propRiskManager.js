/**
 * server/risk/propRiskManager.js
 *
 * Prop Firm Risk Manager — Topstep $50k Combine
 *
 * The combine allows BOTH standard and micro contracts.
 * Standard contracts are 10× larger — same strategy, 10× the P&L.
 *
 * Risk model: symbol-specific risk budget so standard contracts get
 * meaningful position sizes without blowing the $1,000 DLL.
 *
 * Standard contracts (GC, NQ, ES):
 *   - Trade 1 contract, risk up to $500/trade (50% of DLL)
 *   - Self-filtering: if ATR stop > $500 worth, skip the trade
 *   - On moderate-ATR days GC can make $500-1,500/trade
 *
 * Micro contracts (MGC, MNQ, MES):
 *   - $250/trade risk, 1-5 contracts
 */

const DAILY_LOSS_LIMIT = 1000;

// Symbol-specific risk budget per trade
const RISK_PER_TRADE_MAP = {
  // Standard contracts — bigger per-trade budget, 1 contract at a time
  'GC':  500,   // Gold:      $100/pt — 1 contract at $500 risk = 5-pt stop max
  'NQ':  400,   // Nasdaq:    $20/pt  — 1 contract at $400 risk = 20-pt stop max
  'ES':  400,   // S&P 500:   $50/pt  — 1 contract at $400 risk = 8-pt stop max
  'CL':  400,   // Crude Oil: $1000/pt — rarely viable but mapped

  // Micro contracts — $250 budget, multi-contract sizing
  'MGC': 250,
  'MNQ': 250,
  'MES': 250,
  'MYM': 250,
  'M2K': 250,
  'MCL': 250,
};
const RISK_PER_TRADE = 250; // default fallback

// Dollar value per 1 point of price movement, per contract
const FUTURES_RISK_MULTIPLIERS = {
  'GC':  100,    // Standard Gold
  'NQ':  20,     // Standard Nasdaq-100
  'ES':  50,     // Standard S&P 500
  'CL':  1000,   // Standard Crude Oil
  'MGC': 10,     // Micro Gold
  'MNQ': 2,      // Micro Nasdaq-100
  'MES': 5,      // Micro S&P 500
  'MYM': 0.50,   // Micro Dow
  'M2K': 5,      // Micro Russell
  'MCL': 1000,   // Micro Crude (per full-point — use cautiously)
};

/**
 * ATR-based position sizing, symbol-aware.
 *
 * Examples:
 *   GC, 5-pt ATR stop: risk = 5×$100 = $500 → qty = floor(500/500) = 1 ✅
 *   GC, 8-pt ATR stop: risk = 8×$100 = $800 > $500 → qty = 0 (skip) ✅
 *   MGC, 10-pt stop:   risk = 10×$10 = $100 → qty = floor(250/100) = 2 ✅
 *   NQ, 15-pt stop:    risk = 15×$20 = $300 → qty = floor(400/300) = 1 ✅
 *   NQ, 25-pt stop:    risk = 25×$20 = $500 > $400 → qty = 0 (skip) ✅
 *
 * @param {string} symbol
 * @param {number} entryPrice
 * @param {number} stopLossPrice
 * @returns {number} contracts (0 = skip, risk too wide)
 */
function calculatePositionSize(symbol, entryPrice, stopLossPrice) {
  if (typeof entryPrice !== 'number' || typeof stopLossPrice !== 'number') {
    throw new TypeError('Entry price and stop loss price must be numbers');
  }
  if (entryPrice <= 0 || stopLossPrice <= 0) {
    throw new Error('Prices must be greater than 0');
  }

  const distance = Math.abs(entryPrice - stopLossPrice);
  if (distance === 0) throw new Error('Entry and stop cannot be the same');

  const riskBudget         = RISK_PER_TRADE_MAP[symbol] || RISK_PER_TRADE;
  const riskMultiplier     = FUTURES_RISK_MULTIPLIERS[symbol] || 5;
  const dollarRiskPerContr = distance * riskMultiplier;

  let qty = Math.floor(riskBudget / dollarRiskPerContr);

  // If stop is too wide even for 1 contract, skip the trade
  if (qty <= 0) return 0;

  // Topstep hard cap: 5 contracts per position
  const MAX_CONTRACTS = 5;
  return Math.min(qty, MAX_CONTRACTS);
}

module.exports = {
  DAILY_LOSS_LIMIT,
  RISK_PER_TRADE,
  RISK_PER_TRADE_MAP,
  calculatePositionSize,
};
