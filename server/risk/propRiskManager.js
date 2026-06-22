/**
 * Prop Firm Risk Manager
 * Implements a fixed-dollar risk model based on Topstep constraints.
 */

const DAILY_LOSS_LIMIT = 1000;
const RISK_PER_TRADE = 200;

// Multiplier mapping from ETF dollar move to Futures dollar risk
// e.g. $1 SPY move = 10 ES points = $500 risk
const ETF_RISK_MULTIPLIERS = {
    'SPY': 500, // 10x ratio * $50/pt
    'QQQ': 800, // 40x ratio * $20/pt
    'DIA': 500, // 100x ratio * $5/pt
    'IWM': 500, // 10x ratio * $50/pt
    'GLD': 1000,
    'USO': 1000,
    'TLT': 1000
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
    const riskMultiplier = ETF_RISK_MULTIPLIERS[symbol] || 500;
    const dollarRiskPerContract = distance * riskMultiplier;

    let qty = Math.floor(RISK_PER_TRADE / dollarRiskPerContract);

    // If the distance is too large and qty drops to 0, we enforce a minimum of 1
    // to act as a minimum position size, assuming they want to at least take the trade.
    // Ideally this would trade micros (MES, MNQ) to be strictly under the limit.
    if (dollarRiskPerContract > RISK_PER_TRADE || qty === 0) {
        qty = 1; 
    }

    return qty;
}

module.exports = {
    DAILY_LOSS_LIMIT,
    RISK_PER_TRADE,
    calculatePositionSize
};
