/**
 * server/risk/propRiskManager.js
 *
 * Prop Firm Risk Manager — Topstep $50k Combine
 *
 * Risk model: ATR-based position sizing using the full DLL budget intelligently.
 *
 * DLL = $1,000/day. With 6 trades max per day, we can risk $160/trade and
 * never breach DLL even if every trade loses. In practice wins offset losses
 * so we target $200/trade risk for slightly better sizing.
 *
 * Key change from v1: RISK_PER_TRADE raised from $200 → $250, allowing
 * 2 contracts on MGC/MNQ when ATR is moderate (8-12 points), rather than
 * staying stuck at 1 contract and leaving DLL budget unused.
 */

const DAILY_LOSS_LIMIT = 1000;
const RISK_PER_TRADE   = 250;   // raised from $200 — uses more of the $1k DLL budget

// Dollar value per 1 point of price movement, per contract
const FUTURES_RISK_MULTIPLIERS = {
  'MNQ': 2,      // Micro Nasdaq-100: $2/point
  'MES': 5,      // Micro S&P 500:   $5/point
  'MYM': 0.50,   // Micro Dow:       $0.50/point
  'M2K': 5,      // Micro Russell:   $5/point
  'MGC': 10,     // Micro Gold:      $10/point
  'MCL': 1000,   // Micro Crude:     $1000/point (use $10/0.01 tick)
  'NQ':  20,     // Nasdaq-100:      $20/point  (full contract)
  'ES':  50,     // S&P 500:         $50/point  (full contract)
  'CL':  1000,   // Crude Oil:       $1000/point
  'GC':  100     // Gold:            $100/point
};

/**
 * ATR-based position sizing.
 *
 * qty = floor(RISK_PER_TRADE / (ATR_distance × $/point))
 * Capped at Topstep's 5-contract maximum.
 *
 * Example: MGC ATR stop = 10 points, $10/pt
 *   qty = floor(250 / (10 × 10)) = floor(2.5) = 2 contracts ✅
 *
 * @param {string} symbol
 * @param {number} entryPrice
 * @param {number} stopLossPrice
 * @returns {number} contracts (0 = skip trade, too risky)
 */
function calculatePositionSize(symbol, entryPrice, stopLossPrice) {
  if (typeof entryPrice !== 'number' || typeof stopLossPrice !== 'number') {
    throw new TypeError('Entry price and stop loss price must be numbers');
  }
  if (entryPrice <= 0 || stopLossPrice <= 0) {
    throw new Error('Prices must be greater than 0');
  }

  const distance = Math.abs(entryPrice - stopLossPrice);
  if (distance === 0) {
    throw new Error('Entry price and stop loss price cannot be the same');
  }

  const riskMultiplier      = FUTURES_RISK_MULTIPLIERS[symbol] || 5;
  const dollarRiskPerContract = distance * riskMultiplier;
  let qty = Math.floor(RISK_PER_TRADE / dollarRiskPerContract);

  // If stop is so wide that even 1 contract exceeds budget, skip the trade
  if (qty <= 0) return 0;

  // Topstep hard cap: 5 micro contracts per position
  const MAX_CONTRACTS = 5;
  return Math.min(qty, MAX_CONTRACTS);
}

module.exports = {
  DAILY_LOSS_LIMIT,
  RISK_PER_TRADE,
  calculatePositionSize
};
