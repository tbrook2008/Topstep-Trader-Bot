const alpaca = require('../execution/alpacaClient');
const topstepx = require('../execution/topstepxClient');
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
  
  // --- TOPSTEP RULE: Auto-Flatten at 3:00 PM CT (15:00) ---
  const now = new Date();
  const options = { timeZone: 'America/Chicago', hour12: false, hour: 'numeric', minute: 'numeric' };
  const ctTime = new Intl.DateTimeFormat('en-US', options).format(now);
  const [ctHour, ctMinute] = ctTime.split(':').map(Number);

  if (ctHour === 15 && ctMinute >= 0 && ctMinute <= 10) {
    logger.warn('🕒 3:00 PM CT reached! Triggering TopstepX Auto-Flatten to prevent EOD violations.');
    await topstepx.flattenAllPositions();
    // In a full implementation, we would also clear the local DB state here.
    return;
  }
  // --------------------------------------------------------

  // Fetch open trades from local DB since TopstepX lacks a simple positions endpoint
  const { getDb } = require('../db/schema');
  const db = getDb();
  const openTrades = db.prepare('SELECT * FROM trades WHERE status = ?').all('open');

  if (openTrades.length === 0) return;

  const closePromises = [];

  // Symbol map from proxy symbols to topstep
  const SYMBOL_MAP = {
    'SPY': 'ES', 'QQQ': 'NQ', 'DIA': 'YM', 'IWM': 'RTY', 'GLD': 'GC', 'USO': 'CL', 'TLT': 'ZB'
  };

  for (const trade of openTrades) {
    const symbol = trade.symbol;
    const history = barsHistory[symbol];
    if (!history || history.length === 0) continue;
    
    const currentPrice = history[history.length - 1].close;

    if (!currentPrice) {
      logger.warn('Risk Monitor: No current price available for position', { symbol });
      continue;
    }

    let direction = trade.direction;
    let stopLoss = trade.stop_loss;
    let targetPrice = trade.target_price;
    let tradeId = trade.id;

    // Implement Trailing Stop Logic with Dynamic ATR
    let trailDistance = null; // Default to null to prevent distortion if history is missing
    const baseMultiplier = parseFloat(process.env.ATR_MULTIPLIER || '3.5');
    
    // Attempt to recalculate dynamically using recent history
    if (history && history.length >= 14) {
      const atrValue = calculateATR(history, 14);
      if (atrValue) {
        const dynamicMultiplier = getDynamicATRMultiplier(history, baseMultiplier);
        trailDistance = atrValue * dynamicMultiplier;
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
        const tsSymbol = SYMBOL_MAP[symbol] || symbol;
        const res = await topstepx.closePosition(tsSymbol);
        if (res.closed || res.reason === 'Invalid contract ID') { // if invalid contract, maybe it's already closed
          // Estimate PNL
          const pnl = direction === 'LONG' ? (currentPrice - trade.entry_price) : (trade.entry_price - currentPrice);
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
              symbol: symbol,
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
          logger.error(`❌ Failed to close position during risk event`, { symbol: tsSymbol, reason: res.reason });
        }
      })());
    }
  }

  if (closePromises.length > 0) {
    await Promise.allSettled(closePromises);
  }
}

module.exports = { monitorRisk };
