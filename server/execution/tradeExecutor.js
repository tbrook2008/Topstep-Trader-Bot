/**
 * server/execution/tradeExecutor.js
 * Full trade execution pipeline
 */
require('dotenv').config();
const alpaca        = require('./alpacaClient');
const topstepx      = require('./topstepxClient');
const validator     = require('../risk/validator');
const { logTrade }  = require('../db/tradeLogger');
const memory        = require('../db/strategyMemory');
const { setState, getDb }  = require('../db/schema');
const logger        = require('../utils/logger');
const fs = require('fs');
const path = require('path');

let symbolParamsCache = null;
function getSymbolParams(symbol) {
  if (global.OPTIMIZE_PARAMS) return global.OPTIMIZE_PARAMS;
  if (!symbolParamsCache) {
    try {
      const p = path.join(__dirname, '../data/symbolParams.json');
      if (fs.existsSync(p)) symbolParamsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      else symbolParamsCache = {};
    } catch (e) { symbolParamsCache = {}; }
  }
  return symbolParamsCache[symbol] || {};
}

const vwapReversion = require('../quantitative/vwapReversion');
const propRiskManager = require('../risk/propRiskManager');
const { calculateATR, getDynamicATRMultiplier } = require('../quantitative/atr');
const { analyzeVolume, classifyVolume } = require('../quantitative/volumeProfile');

const DRY_RUN            = process.env.DRY_RUN === 'true';
const ATR_MULTIPLIER     = parseFloat(process.env.ATR_MULTIPLIER        || '3.5');

/**
 * Full trade execution pipeline based purely on math.
 * @param {{ bundle }} params
 */
async function execute({ bundle }) {
  const symbol = bundle.symbol;
  const price  = bundle.price;
  const mode   = process.env.TRADING_MODE || 'paper';
  const history = bundle.history;
  const history5m = bundle.history5m;

  const signal = vwapReversion.evaluate(history, symbol);
  if (!signal) {
    return { executed: false, reason: 'VWAP Reversion conditions not met' };
  }

  // Session time filter (EST)
  const now = new Date();
  const nyTimeStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const nyTime = new Date(nyTimeStr);
  const timeVal = nyTime.getHours() * 100 + nyTime.getMinutes();
  if (!((timeVal >= 945 && timeVal <= 1130) || (timeVal >= 1330 && timeVal <= 1530))) {
    logger.warn('Trade blocked: Outside optimal trading hours', { timeVal });
    return { executed: false, reason: 'Outside optimal trading session' };
  }
  
  const direction = signal.action;
  const strategy  = 'VWAP Mean Reversion';
  const regime    = 'mean-reverting';
  const isTrending = false;
  
  const volClass = classifyVolume(history).toUpperCase();

  // Macro Trend Alignment (200 SMA) - Only for trend-following strategies
  if (regime !== 'mean-reverting') {
    const smaPeriod = Math.min(history.length, 200);
    const smaSlice = history.slice(-smaPeriod);
    const sma = smaSlice.reduce((sum, b) => sum + b.close, 0) / smaPeriod;
    if (direction === 'LONG' && price < sma) {
        logger.warn(`Trade blocked: LONG but price (${price}) < 200 SMA (${sma})`);
        return { executed: false, reason: 'Macro Trend Alignment: Counter-trend LONG' };
    }
    if (direction === 'SHORT' && price > sma) {
        logger.warn(`Trade blocked: SHORT but price (${price}) > 200 SMA (${sma})`);
        return { executed: false, reason: 'Macro Trend Alignment: Counter-trend SHORT' };
    }
  }

  logger.info('Trade executor started', {
    symbol,
    direction,
    regime,
    strategy
  });

  let account = { balance: 50000, canTrade: true };
  if (!DRY_RUN) {
    try {
      account = await topstepx.getAccountBalance() || account;
      if (!account) throw new Error('TopstepX returned null account balance');
    } catch (err) {
      logger.error('Failed to fetch TopstepX account data', { error: err.message });
      return { executed: false, reason: 'TopstepX account fetch failed' };
    }
  }

  const liveBalance = account.currentBalance || account.accountBalance || account.balance || 50000;

  if (!account.canTrade && !DRY_RUN) {
    logger.warn('Account trading is blocked — skipping', { symbol });
    return { executed: false, reason: 'TopstepX account trading blocked' };
  }

  // Step 3: Prop Firm sizing
  let qty = 0;
  try {
    qty = propRiskManager.calculatePositionSize(symbol, price, signal.stopLoss);
  } catch (err) {
    logger.warn('Failed to calculate position size', { symbol, error: err.message });
    return { executed: false, reason: 'Invalid position sizing' };
  }
  
  const sizing = {
    qty: qty,
    positionDollars: propRiskManager.RISK_PER_TRADE || 200
  };

  if (sizing.qty === 0) {
    logger.warn('Calculated quantity is 0, skipping trade', { symbol });
    return { executed: false, reason: 'Quantity evaluated to 0' };
  }
  
  let openTrades = [];
  try {
    const db = getDb();
    openTrades = db.prepare("SELECT * FROM trades WHERE status = 'open'").all();
  } catch (err) {
    logger.warn('Failed to fetch open trades from DB', { error: err.message });
  }

  // Step 4: Validation (Skip Alpaca validation for now, or adapt it)
  const validation = await validator.runChecks({
    consensus: { approved: true, direction, regime }, // Mock consensus for validator backward compatibility
    symbol,
    positionDollars: sizing.positionDollars,
    alpacaAccount:   { portfolioValue: liveBalance, buyingPower: liveBalance, cash: liveBalance, equity: liveBalance, tradingBlocked: false },
    openPositions:   openTrades, // Trust DB for open positions
    liveBalance,
  });

  if (!validation.passed) {
    logger.warn('Trade blocked by validator', { symbol, failed: validation.failed });
    return { executed: false, reason: `Validator: ${validation.failed.join(', ')}` };
  }

  // Step 5: Stops & Targets mapping
  const side = direction === 'LONG' ? 'buy' : 'sell';
  const targetDist = Math.abs(price - signal.target);
  const trailPrice = Math.abs(price - signal.stopLoss);

  // Step 5b: Volume Profile check
  const volAnalysis = analyzeVolume(bundle.history, direction, symbol);
  logger.info('Volume profile', { symbol, volume: volClass, ratio: volAnalysis.ratio?.toFixed(2), reason: volAnalysis.reason });
  if (!volAnalysis.supported) {
    logger.warn('Trade blocked by volume profile', { symbol, reason: volAnalysis.reason, ratio: volAnalysis.ratio });
    return { executed: false, reason: `Volume: ${volAnalysis.reason}` };
  }

  // Step 6: Calculate Stops & Targets

  const atrStop   = signal.stopLoss;
  const atrTarget = signal.target;

  if (DRY_RUN) {
    logger.info('🔍 DRY RUN — no order submitted', {
      symbol, side, qty: sizing.qty, trailPrice: trailPrice.toFixed(2),
    });
    return { executed: false, dryRun: true, sizing, validation, reason: 'Dry run mode' };
  }

  // Step 7: Execute via TopstepX
  let order;
  const tsSymbol = symbol;

  function calculateTicks(sym, pointDistance) {
    let tickSize = 1;
    switch (sym) {
      case 'MES': tickSize = 0.25; break;
      case 'MNQ': tickSize = 0.25; break;
      case 'MYM': tickSize = 1.00; break;
      case 'M2K': tickSize = 0.10; break;
      case 'MGC': tickSize = 0.10; break;
      case 'MCL': tickSize = 0.01; break;
      case 'ES': tickSize = 0.25; break;
      case 'NQ': tickSize = 0.25; break;
      case 'CL': tickSize = 0.01; break;
      case 'GC': tickSize = 0.10; break;
      default: tickSize = 0.25; break;
    }
    return Math.round(pointDistance / tickSize);
  }

  const tpTicks = calculateTicks(symbol, targetDist);
  const slTicks = calculateTicks(symbol, trailPrice);

  try {
    const tsResponse = await topstepx.placeMarketOrder(tsSymbol, side, sizing.qty, tpTicks, slTicks, price);
    if (!tsResponse) throw new Error('TopstepX Order Failed');
    
    order = { orderId: tsResponse.orderId || 'ts-order-' + Date.now() };
    logger.info(`✅ Market order submitted to TopstepX: ${tsSymbol} | OrderID: ${order.orderId} | Qty: ${sizing.qty}`);
  } catch (err) {
    const errorDetails = err.response ? err.response.data : err.message;
    logger.error('❌ Order submission failed', { symbol: tsSymbol, error: err.message, details: errorDetails });
    return { executed: false, reason: `TopstepX Error: ${err.message}` };
  }

  // Step 8: Log trade — store ATR-derived stop/target so riskMonitor can pick them up
  const tradeId = logTrade({
    symbol,
    direction,
    qty:            sizing.qty,
    entryPrice:     price,
    stopLoss:       parseFloat(atrStop.toFixed(4)),
    targetPrice:    parseFloat(atrTarget.toFixed(4)),
    alpacaOrderId:  order.orderId,
    decisionId:     strategy, // Use strategy name as decision ID for logging
    mode,
  });

  // Step 9: Strategy memory
  memory.saveSetup({
    tradeId,
    symbol,
    regime,
    direction,
    compositeScore: 80,
  });

  setState(`last_trade_${symbol}`, new Date().toISOString());

  // Topstep Prop Firm Bot: Webhook removed to decouple from the Friends Exec Node

  return {
    executed:        true,
    tradeId,
    orderId:         order.orderId,
    symbol,
    direction,
    qty:             sizing.qty,
    entryPrice:      price,
    trailPrice:      parseFloat(trailPrice.toFixed(2)),
    targetDist:      parseFloat(targetDist.toFixed(2)),
    targetPrice:     parseFloat(atrTarget.toFixed(4)),
    stopLossPrice:   parseFloat(atrStop.toFixed(4)),
    positionDollars: sizing.positionDollars,
  };
}

module.exports = { execute };
