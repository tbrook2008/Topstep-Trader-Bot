const { getDb } = require('./schema');
const logger = require('../utils/logger');

function saveSetup({ tradeId, symbol, ema9, ema21, rsi14, trend, regime, direction, compositeScore }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO strategy_memory
      (trade_id, symbol, ema9, ema21, rsi14, trend, regime, direction, composite_score, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tradeId ?? null, symbol,
    ema9 ?? null, ema21 ?? null, rsi14 ?? null,
    trend ?? null, regime ?? null, direction ?? null,
    compositeScore ?? null,
    new Date().toISOString()
  );
}

function updateOutcome({ tradeId, pnl }) {
  const db = getDb();
  const outcome = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  db.prepare('UPDATE strategy_memory SET outcome = ?, pnl = ? WHERE trade_id = ?')
    .run(outcome, pnl, tradeId);
}

/**
 * Get win-rate and average P&L stats for a symbol (used by Kelly Criterion)
 * Falls back to all-symbol stats if insufficient per-symbol data.
 */
function getWinStats(symbol) {
  const db = getDb();

  const query = (sym) => db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      SUM(CASE WHEN outcome = 'win'  THEN 1 ELSE 0 END) AS wins,
      AVG(CASE WHEN outcome = 'win'  THEN pnl END)       AS avgWin,
      AVG(CASE WHEN outcome = 'loss' THEN ABS(pnl) END)  AS avgLoss
    FROM strategy_memory
    WHERE outcome IS NOT NULL
    ${sym ? "AND symbol = ?" : ""}
  `).get(...(sym ? [sym] : []));

  let stats = query(symbol);

  // Need at least 10 trades for meaningful stats; fall back to aggregate
  if (!stats || stats.total < 10) {
    stats = query(null);
  }

  if (!stats || stats.total < 5) {
    // Absolute fallback — conservative defaults
    return { winRate: 0.5, avgWin: 0.03, avgLoss: 0.02, total: 0 };
  }

  return {
    winRate: stats.wins / stats.total,
    avgWin:  (stats.avgWin  || 0.03),
    avgLoss: (stats.avgLoss || 0.02),
    total:   stats.total
  };
}

function getTopPatterns(limit = 5) {
  return getDb().prepare(`
    SELECT symbol, trend, regime, direction,
           COUNT(*) AS count,
           AVG(pnl) AS avg_pnl,
           SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS win_rate
    FROM strategy_memory
    WHERE outcome IS NOT NULL
    GROUP BY symbol, trend, regime, direction
    HAVING count >= 3
    ORDER BY avg_pnl DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { saveSetup, updateOutcome, getWinStats, getTopPatterns };
