/**
 * Prop Firm Risk Manager
 * Implements a fixed-dollar risk model.
 */

const DAILY_LOSS_LIMIT = 1000;
const RISK_PER_TRADE = 200;

/**
 * Calculates the appropriate position size based on entry and stop loss prices.
 * 
 * @param {string} symbol - The ticker symbol.
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

    let qty = Math.floor(RISK_PER_TRADE / distance);

    // If the distance is greater than the risk per trade, Math.floor would result in 0.
    // We enforce a minimum of 1 as a micro equivalent to adhere to risk limits.
    if (distance > RISK_PER_TRADE || qty === 0) {
        qty = 1;
    }

    return qty;
}

module.exports = {
    DAILY_LOSS_LIMIT,
    RISK_PER_TRADE,
    calculatePositionSize
};
