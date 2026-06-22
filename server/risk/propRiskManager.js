/**
 * Prop Firm Risk Manager
 * Implements a fixed-dollar risk model based on Topstep constraints.
 */

const DAILY_LOSS_LIMIT = 1000;
const RISK_PER_TRADE = 200;

// Multiplier mapping from ETF dollar move to Micro Futures dollar risk
// e.g. $1 SPY move = 10 MES points = $50 risk
const ETF_RISK_MULTIPLIERS = {
    'SPY': 50,  // MES: 1 SPY pt = 10 MES pts = 10 * $5 = $50
    'QQQ': 80,  // MNQ: 1 QQQ pt = 40 MNQ pts = 40 * $2 = $80
    'DIA': 50,  // MYM: 1 DIA pt = 100 MYM pts = 100 * $0.50 = $50
    'IWM': 50,  // M2K: 1 IWM pt = 10 M2K pts = 10 * $5 = $50
    'GLD': 100, // MGC: 1 GLD pt = 10 MGC pts = 10 * $10 = $100
    'USO': 100, // MCL: 1 USO pt = 10 MCL pts = 10 * $10 = $100
    'TLT': 1000 // ZB: No micro equivalent mapped, assume full $1000/pt
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
    const riskMultiplier = ETF_RISK_MULTIPLIERS[symbol] || 50;
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
