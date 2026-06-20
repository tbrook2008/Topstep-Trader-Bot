require('dotenv').config();
const crypto = require('crypto');
const { getDb, getState, setState } = require('./schema');
const logger = require('../utils/logger');

function createHmac(data) {
  return crypto
    .createHmac('sha256', process.env.LOG_HMAC_SECRET || 'fallback-secret')
    .update(data)
    .digest('hex');
}

function logDecision({ symbol, geminiScore, geminiThesis, ollamaSentiment, deepseekScore, compositeScore, approved, direction, reason, nodesUsed }) {
  const db = getDb();
  const timestamp = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO ai_decisions
      (timestamp, symbol, gemini_score, gemini_thesis, ollama_sentiment, deepseek_score,
       composite_score, approved, direction, reason, nodes_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    timestamp, symbol,
    geminiScore ?? null, geminiThesis ?? null,
    ollamaSentiment ?? null, deepseekScore ?? null,
    compositeScore, approved ? 1 : 0,
    direction ?? null, reason ?? null,
    nodesUsed ? JSON.stringify(nodesUsed) : null
  );

  logger.info('Decision logged', { id: result.lastInsertRowid, symbol, approved, compositeScore });
  return result.lastInsertRowid;
}

function logTrade({ symbol, direction, qty, entryPrice, stopLoss, targetPrice, alpacaOrderId, decisionId, mode }) {
  const db = getDb();
  const timestamp = new Date().toISOString();
  const prevHmac = getState('last_hmac');

  const tradeData = JSON.stringify({ timestamp, symbol, direction, qty, entryPrice, stopLoss, alpacaOrderId });
  const hmac = createHmac(prevHmac + tradeData);

  const stmt = db.prepare(`
    INSERT INTO trades
      (timestamp, symbol, direction, qty, entry_price, stop_loss, target_price,
       alpaca_order_id, status, hmac, prev_hmac, decision_id, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)
  `);

  const result = stmt.run(
    timestamp, symbol, direction, qty,
    entryPrice ?? null, stopLoss ?? null, targetPrice ?? null,
    alpacaOrderId ?? null, hmac, prevHmac,
    decisionId ?? null, mode || 'paper'
  );

  // Update chain anchor
  setState('last_hmac', hmac);

  // Update counters
  const total = parseInt(getState('total_trades') || '0') + 1;
  setState('total_trades', total);

  logger.info('Trade logged', { id: result.lastInsertRowid, symbol, direction, qty, hmac: hmac.slice(0, 8) + '...' });
  return result.lastInsertRowid;
}

function updateTradeOutcome({ tradeId, exitPrice, pnl, status }) {
  const db = getDb();
  db.prepare('UPDATE trades SET exit_price = ?, pnl = ?, status = ? WHERE id = ?')
    .run(exitPrice ?? null, pnl ?? null, status, tradeId);

  // Update daily PnL
  const today = new Date().toISOString().slice(0, 10);
  const storedDate = getState('daily_pnl_date');
  let dailyPnl = storedDate === today ? parseFloat(getState('daily_pnl') || '0') : 0;
  dailyPnl += (pnl || 0);
  setState('daily_pnl', dailyPnl);
  setState('daily_pnl_date', today);

  // Track wins/losses
  if (pnl !== null && pnl !== undefined) {
    if (pnl > 0) {
      const wins = parseInt(getState('total_wins') || '0') + 1;
      setState('total_wins', wins);
      setState('consecutive_losses', '0');
    } else {
      const losses = parseInt(getState('consecutive_losses') || '0') + 1;
      setState('consecutive_losses', losses);
    }
  }

  logger.info('Trade outcome updated', { tradeId, pnl, status });
}

function updateTradeStopLoss(tradeId, stopLoss) {
  const db = getDb();
  db.prepare('UPDATE trades SET stop_loss = ? WHERE id = ?').run(stopLoss, tradeId);
  logger.info('Trade stop loss updated in DB', { tradeId, stopLoss });
}

function getRecentDecisions(limit = 20) {
  return getDb()
    .prepare('SELECT * FROM ai_decisions ORDER BY id DESC LIMIT ?')
    .all(limit);
}

function getRecentTrades(limit = 20) {
  return getDb()
    .prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?')
    .all(limit);
}

function getOpenTradeBySymbol(symbol) {
  return getDb()
    .prepare(`
      SELECT * FROM trades 
      WHERE symbol = ? AND status IN ('submitted', 'open') 
      ORDER BY id DESC LIMIT 1
    `)
    .get(symbol);
}

function getDailyPnl() {
  const today = new Date().toISOString().slice(0, 10);
  const storedDate = getState('daily_pnl_date');
  return storedDate === today ? parseFloat(getState('daily_pnl') || '0') : 0;
}

module.exports = { logDecision, logTrade, updateTradeOutcome, updateTradeStopLoss, getRecentDecisions, getRecentTrades, getOpenTradeBySymbol, getDailyPnl };
