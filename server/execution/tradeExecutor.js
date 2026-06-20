/**
 * server/execution/tradeExecutor.js
 * Full trade execution pipeline
 */
require('dotenv').config();
const alpaca        = require('./alpacaClient');
const kelly         = require('../risk/kellyCriterion');
const validator     = require('../risk/validator');
const { logTrade }  = require('../db/tradeLogger');
const memory        = require('../db/strategyMemory');
const { setState }  = require('../db/schema');
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

const macd = require('../quantitative/macd');
const bollingerRsi = require('../quantitative/bollingerRsi');
const kalman = require('../quantitative/kalman');
const ouModel = require('../quantitative/ouModel');
const { calculateATR, getDynamicATRMultiplier } = require('../quantitative/atr');
const { analyzeVolume, classifyVolume } = require('../quantitative/volumeProfile');
const hmm = require('../quantitative/hmm');
const hurst = require('../quantitative/hurst');
const vwap = require('../quantitative/vwap');

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

  // Step 1: Advanced Regime Detection (Hurst Exponent)
  const H = hurst.calculateHurst(history);
  const regime = hurst.classifyRegime(history);
  const isTrending = regime === 'trending';
  
  // Step 2: Strict Quantitative Trigger
  let direction = 'NO_TRADE';
  let strategy = '';

  if (regime === 'chop') {
    return { executed: false, reason: `Chop regime detected (H=${H.toFixed(2)}). Sitting on hands to preserve capital.` };
  }

  if (regime === 'trending') {
    // Require MACD + High Volume + Kalman
    const macdDir = macd.evaluate(history);
    const kalmanDir = kalman.evaluate(history, symbol);
    const volClass = classifyVolume(history);
    
    if (kalmanDir !== 'NO_TRADE' && macdDir === kalmanDir && (volClass === 'high' || volClass === 'climax')) {
      direction = kalmanDir;
    }
    if (direction !== 'NO_TRADE') strategy = 'Kalman+MACD';
  } else if (regime === 'mean-reverting') {
    // Require Bollinger Bands extreme + OU Model
    const bbRsiDir = bollingerRsi.evaluate(history);
    const ouDir = ouModel.evaluate(history, symbol);
    
    if (bbRsiDir === ouDir && ouDir !== 'NO_TRADE') {
      direction = ouDir;
      strategy = 'OU+Bollinger';
    }
  }

  if (direction === 'NO_TRADE') {
    return { executed: false, reason: `Strict confirmation models not met for ${regime} regime` };
  }

  if (isTrending && history && history.length > 0) {
    const params = getSymbolParams(symbol);
    const trendPeriod = params.trendPeriod || 50;
    const period = Math.min(trendPeriod, history.length);
    const recent = history.slice(-period);
    const sma = recent.reduce((sum, b) => sum + b.close, 0) / period;
    if (direction === 'LONG' && price < sma) {
      return { executed: false, reason: 'Macro trend alignment failed (price below SMA)' };
    }
    if (direction === 'SHORT' && price > sma) {
      return { executed: false, reason: 'Macro trend alignment failed (price above SMA)' };
    }
  }

  logger.info('Trade executor started', {
    symbol,
    direction,
    regime,
    strategy
  });

  // Step 2: Fetch live account data
  let account, openPositions;
  try {
    [account, openPositions] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getOpenPositions(),
    ]);
  } catch (err) {
    logger.error('Failed to fetch Alpaca account data', { error: err.message });
    return { executed: false, reason: 'Alpaca account fetch failed' };
  }

  const liveBalance = account.portfolioValue;

  if (account.tradingBlocked) {
    logger.warn('Account trading is blocked — skipping', { symbol });
    return { executed: false, reason: 'Alpaca account trading blocked' };
  }

  // Step 3: Kelly sizing (no consensus score, default 80 confidence)
  const sizing = kelly.getPositionSize(symbol, price, liveBalance, 80, account.buyingPower);
  
  // Alpaca does not support fractional shorting. We must floor the quantity.
  if (direction === 'SHORT') {
    sizing.qty = Math.floor(sizing.qty);
  }

  if (sizing.qty === 0) {
    logger.warn('Insufficient buying power for trade', { symbol, buyingPower: account.buyingPower });
    return { executed: false, reason: 'Insufficient buying power' };
  }
  
  // Step 4: Validation
  const validation = await validator.runChecks({
    consensus: { approved: true, direction, regime }, // Mock consensus for validator backward compatibility
    symbol,
    positionDollars: sizing.positionDollars,
    alpacaAccount:   account,
    openPositions,
    liveBalance,
  });

  if (!validation.passed) {
    logger.warn('Trade blocked by validator', { symbol, failed: validation.failed });
    return { executed: false, reason: `Validator: ${validation.failed.join(', ')}` };
  }

  // Step 5: Dynamic ATR Risk Rails
  const atrValue = calculateATR(bundle.history, 14);
  if (!atrValue) {
    logger.warn('Insufficient data to calculate ATR — skipping', { symbol });
    return { executed: false, reason: 'Insufficient ATR data' };
  }

  const dynamicMultiplier = getDynamicATRMultiplier(bundle.history, ATR_MULTIPLIER);
  const trailPrice  = atrValue * dynamicMultiplier;
  const params = getSymbolParams(symbol);
  const dynamicRR = isTrending ? (params.dynamicRR_Trending || 2.0) : (params.dynamicRR_MeanRev || 1.0);
  const targetDist  = atrValue * dynamicMultiplier * dynamicRR;
  const side = direction === 'LONG' ? 'buy' : 'sell';

  // Step 5b: Volume Profile check
  const volAnalysis = analyzeVolume(bundle.history, direction, symbol);
  const volClass    = classifyVolume(bundle.history);
  logger.info('Volume profile', { symbol, volume: volClass, ratio: volAnalysis.ratio?.toFixed(2), reason: volAnalysis.reason });
  if (!volAnalysis.supported) {
    logger.warn('Trade blocked by volume profile', { symbol, reason: volAnalysis.reason, ratio: volAnalysis.ratio });
    return { executed: false, reason: `Volume: ${volAnalysis.reason}` };
  }

  // Step 6: Calculate Stops & Targets

  const atrStop   = direction === 'LONG' ? price - trailPrice : price + trailPrice;
  const atrTarget = direction === 'LONG' ? price + targetDist  : price - targetDist;

  if (DRY_RUN) {
    logger.info('🔍 DRY RUN — no order submitted', {
      symbol, side, qty: sizing.qty, trailPrice: trailPrice.toFixed(2),
    });
    return { executed: false, dryRun: true, sizing, validation, reason: 'Dry run mode' };
  }

  // Step 7: Execute via Alpaca
  let order;
  try {
    order = await alpaca.submitOrder({
      symbol,
      qty:        sizing.qty,
      side,
    });
    logger.info(`✅ Market order submitted: ${symbol} | OrderID: ${order.orderId} | Qty: ${sizing.qty}`);
  } catch (err) {
    const errorDetails = err.response ? err.response.data : err.message;
    logger.error('❌ Order submission failed', { symbol, error: err.message, details: errorDetails });
    return { executed: false, reason: `Alpaca Error: ${err.message}` };
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

  // Broadast webhook to Friends' Exec Node (Project 2)
  try {
    const http = require('http');
    const payload = JSON.stringify({
      symbol,
      direction,
      price,
      trailPrice: parseFloat(trailPrice.toFixed(2)),
      targetPrice: parseFloat(atrTarget.toFixed(4)),
      isTrending,
      positionPct: sizing ? parseFloat((sizing.positionDollars / liveBalance).toFixed(4)) : 0.05
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
    req.on('error', (err) => { logger.warn('Webhook error (Friends Exec Node may be offline)', err.message); });
    req.write(payload);
    req.end();
  } catch (e) { }

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
    positionDollars: sizing.positionDollars,
  };
}

module.exports = { execute };
