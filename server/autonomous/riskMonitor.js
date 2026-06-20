const alpaca = require('../execution/alpacaClient');
const http = require('http');
const { getOpenTradeBySymbol, updateTradeOutcome, logTrade, updateTradeStopLoss } = require('../db/tradeLogger');
const { isCryptoSymbol } = require('../data/dataAggregator');
const logger = require('../utils/logger');
const { barsHistory } = require('../data/dataAggregator');
const { calculateATR, getDynamicATRMultiplier } = require('../quantitative/atr');

/**
 * Periodically checks ALL open positions against local DB stop-loss and take-profit limits.
 * Required because we removed Alpaca OCO/Bracket orders to avoid integer/distance constraints.
 */
async function monitorRisk() {
  logger.info('🛡️ Running risk monitor for all positions...');
  
  let positions;
  try {
    positions = await alpaca.getOpenPositions();
  } catch (err) {
    logger.error('Risk Monitor: Failed to fetch positions', { error: err.message });
    return;
  }

  const closePromises = [];

  for (const pos of positions) {
    let symbol = pos.symbol;
    // Map Alpaca format 'DOGEUSD' → internal 'DOGE/USD' using regex
    if (/^[A-Z]+USD$/.test(symbol) && symbol !== 'USD') {
      symbol = symbol.slice(0, -3) + '/USD';
    }
    
    const currentPrice = pos.currentPrice;

    if (!currentPrice) {
      logger.warn('Risk Monitor: No current price available for position', { symbol });
      continue;
    }

    const trade = getOpenTradeBySymbol(symbol);
    let direction = 'LONG';
    let stopLoss = null;
    let targetPrice = null;
    let tradeId = null;

    if (trade) {
      direction = trade.direction;
      stopLoss = trade.stop_loss;
      targetPrice = trade.target_price;
      tradeId = trade.id;
    } else {
      // Fail-safe: Apply default risk parameters to orphaned/manual Alpaca positions
      direction = pos.side === 'long' ? 'LONG' : 'SHORT';
      const stopPct = parseFloat(process.env.STOP_LOSS_PCT || '0.02');
      const targetPct = parseFloat(process.env.TAKE_PROFIT_PCT || '0.04');
      
      if (direction === 'LONG') {
        stopLoss = pos.avgEntry * (1 - stopPct);
        targetPrice = pos.avgEntry * (1 + targetPct);
      } else {
        stopLoss = pos.avgEntry * (1 + stopPct);
        targetPrice = pos.avgEntry * (1 - targetPct);
      }
    }

    // Implement Trailing Stop Logic with Dynamic ATR
    let trailDistance = null; // Default to null to prevent distortion if history is missing
    const baseMultiplier = parseFloat(process.env.ATR_MULTIPLIER || '3.5');
    
    // Attempt to recalculate dynamically using recent history
    const history = barsHistory[symbol];
    if (history && history.length >= 14) {
      const atrValue = calculateATR(history, 14);
      if (atrValue) {
        const dynamicMultiplier = getDynamicATRMultiplier(history, baseMultiplier);
        trailDistance = atrValue * dynamicMultiplier;
        logger.debug(`Dynamic Trail Distance for ${symbol}: $${trailDistance.toFixed(4)} (Mult: ${dynamicMultiplier.toFixed(2)})`);
      }
    }

    if (trailDistance !== null && direction === 'LONG') {
      const newTrailingStop = currentPrice - trailDistance;
      if (newTrailingStop > stopLoss) {
        stopLoss = newTrailingStop;
        if (tradeId) {
          logger.info(`Ratcheting Trailing Stop UP for ${symbol} to $${stopLoss.toFixed(2)}`);
          updateTradeStopLoss(tradeId, stopLoss);
        }
      }
    } else if (trailDistance !== null && direction === 'SHORT') {
      const newTrailingStop = currentPrice + trailDistance;
      if (newTrailingStop < stopLoss) {
        stopLoss = newTrailingStop;
        if (tradeId) {
          logger.info(`Ratcheting Trailing Stop DOWN for ${symbol} to $${stopLoss.toFixed(2)}`);
          updateTradeStopLoss(tradeId, stopLoss);
        }
      }
    }

    let trigger = null;

    if (direction === 'LONG') {
      if (stopLoss && currentPrice <= stopLoss) trigger = 'STOP_LOSS';
      if (targetPrice && currentPrice >= targetPrice) trigger = 'TAKE_PROFIT';
    } else if (direction === 'SHORT') {
      if (stopLoss && currentPrice >= stopLoss) trigger = 'STOP_LOSS';
      if (targetPrice && currentPrice <= targetPrice) trigger = 'TAKE_PROFIT';
    }

    if (trigger) {
      logger.info(`🚨 Risk limit breached! Triggering ${trigger}`, { 
        symbol, currentPrice, stopLoss, targetPrice 
      });

      closePromises.push((async () => {
        // Pass the raw Alpaca symbol (pos.symbol) to closePosition, NOT the DB format
        const res = await alpaca.closePosition(pos.symbol);
        if (res.closed) {
          const pnl = pos.unrealizedPL;
          if (tradeId) {
            updateTradeOutcome({
              tradeId: tradeId,
              exitPrice: currentPrice,
              pnl,
              status: 'closed'
            });
          }
          logger.info(`✅ Closed position successfully`, { symbol, pnl });

          // Broadcast CLOSE to Friends
          try {
            const payload = JSON.stringify({
              symbol: pos.symbol,
              direction: 'CLOSE',
              price: currentPrice
            });
            const req = http.request({
              hostname: 'localhost',
              port: 4000,
              path: '/api/internal/signal',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
              }
            });
            req.on('error', (e) => logger.error(`Webhook error: ${e.message}`));
            req.write(payload);
            req.end();
          } catch (e) {
            logger.error(`Failed to send close webhook: ${e.message}`);
          }
        } else {
          logger.error(`❌ Failed to close position during risk event`, { symbol, reason: res.reason });
        }
      })());
    }
  }

  if (closePromises.length > 0) {
    await Promise.allSettled(closePromises);
  }
}

module.exports = { monitorRisk };
