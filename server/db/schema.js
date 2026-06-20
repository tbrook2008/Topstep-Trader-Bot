require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'trader.sqlite');
let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
  }
  return _db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    -- AI decisions from consensus pipeline
    CREATE TABLE IF NOT EXISTS ai_decisions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT    NOT NULL,
      symbol           TEXT    NOT NULL,
      gemini_score     REAL,
      gemini_thesis    TEXT,
      ollama_sentiment REAL,
      deepseek_score   REAL,
      composite_score  REAL    NOT NULL,
      approved         INTEGER NOT NULL DEFAULT 0,
      direction        TEXT,
      reason           TEXT,
      nodes_used       TEXT
    );

    -- Executed trades with HMAC integrity chain
    CREATE TABLE IF NOT EXISTS trades (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT    NOT NULL,
      symbol           TEXT    NOT NULL,
      direction        TEXT    NOT NULL,
      qty              REAL    NOT NULL,
      entry_price      REAL,
      stop_loss        REAL,
      target_price     REAL,
      alpaca_order_id  TEXT,
      status           TEXT    NOT NULL DEFAULT 'submitted',
      exit_price       REAL,
      pnl              REAL,
      hmac             TEXT    NOT NULL,
      prev_hmac        TEXT    NOT NULL,
      decision_id      INTEGER,
      mode             TEXT    NOT NULL DEFAULT 'paper'
    );

    -- Strategy memory: indicator state at time of trade + outcome
    CREATE TABLE IF NOT EXISTS strategy_memory (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id        INTEGER,
      symbol          TEXT    NOT NULL,
      ema9            REAL,
      ema21           REAL,
      rsi14           REAL,
      trend           TEXT,
      regime          TEXT,
      direction       TEXT,
      composite_score REAL,
      outcome         TEXT,
      pnl             REAL,
      timestamp       TEXT    NOT NULL
    );

    -- Persistent system state (survives restarts)
    CREATE TABLE IF NOT EXISTS system_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_decisions_symbol   ON ai_decisions (symbol, timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol      ON trades (symbol, timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_status      ON trades (status);
    CREATE INDEX IF NOT EXISTS idx_memory_symbol      ON strategy_memory (symbol);
  `);

  // Seed default system state values
  const seed = db.prepare('INSERT OR IGNORE INTO system_state (key, value) VALUES (?, ?)');
  const seeds = [
    ['kill_switch',         'false'],
    ['kill_switch_reason',  ''],
    ['last_run',            ''],
    ['last_hmac',           '0000000000000000000000000000000000000000000000000000000000000000'],
    ['daily_pnl',           '0'],
    ['daily_pnl_date',      ''],
    ['consecutive_losses',  '0'],
    ['trading_mode',        process.env.TRADING_MODE || 'paper'],
    ['total_trades',        '0'],
    ['total_wins',          '0'],
  ];
  const insertMany = db.transaction((rows) => rows.forEach(r => seed.run(r[0], r[1])));
  insertMany(seeds);

  logger.info('Database initialized', { path: DB_PATH });
  return db;
}

function getState(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

module.exports = { getDb, initDb, getState, setState };
