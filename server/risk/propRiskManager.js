/**
 * Prop Firm Risk Manager
 * Implements a fixed-dollar risk model based on Topstep constraints.
 */

const DAILY_LOSS_LIMIT = 1000;
const RISK_PER_TRADE = 200;

// Multiplier mapping for Futures dollar risk
// e.g. MNQ: 1 point = $2
const FUTURES_RISK_MULTIPLIERS = {
    'MNQ': 2,
    'MES': 5,
    'MYM': 0.50,
    'M2K': 5,
    'MGC': 10,
    'MCL': 1000,
    'NQ': 20,
    'ES': 50,
    'CL': 1000,
    'GC': 100
};

/**
 * Calculates the appropriate position size based on entry and stop loss prices.
 * 
 * @param {string} symbol - The ticker symbol (e.g. SPY)
 * @param {number} entryPrice - The entry price.
 * @param {number} stopLossPrice - The stop loss price.
 * @returns {number} The calculated position size (quantity).
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

    // Determine dollar risk per contract based on the underlying futures contract
    const riskMultiplier = FUTURES_RISK_MULTIPLIERS[symbol] || 5;
    const dollarRiskPerContract = distance * riskMultiplier;

    let qty = Math.floor(RISK_PER_TRADE / dollarRiskPerContract);

    // If the distance is too large and qty drops to 0, we DO NOT force a trade.
    // The risk is too high even for 1 micro contract, so return 0 to skip.
    if (qty <= 0) {
        return 0; 
    }

    // Topstep Max Contract Limit (e.g. 5 contracts for 50k combine)
    const MAX_CONTRACTS = 5;
    if (qty > MAX_CONTRACTS) {
        qty = MAX_CONTRACTS;
    }

    return qty;
}

module.exports = {
    DAILY_LOSS_LIMIT,
    RISK_PER_TRADE,
    calculatePositionSize
};
