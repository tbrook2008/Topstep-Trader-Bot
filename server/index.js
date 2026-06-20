require('dotenv').config();
const express       = require('express');
const path          = require('path');
const { initDb, getState, setState } = require('./db/schema');
const { getRecentDecisions, getRecentTrades, getDailyPnl } = require('./db/tradeLogger');
const killSwitch    = require('./risk/killSwitch');
const alpacaClient  = require('./execution/alpacaClient');
const logger        = require('./utils/logger');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize DB
initDb();

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

/** System health & status — fetches LIVE balance from Alpaca */
app.get('/api/status', async (req, res) => {
  try {
    const account = await alpacaClient.getAccount();
    res.json({
      ok:              true,
      mode:            (process.env.TRADING_MODE || 'paper').toUpperCase(),
      balance:         account.portfolioValue,
      buyingPower:     account.buyingPower,
      cash:            account.cash,
      equity:          account.equity,
      killSwitch:      killSwitch.isActive(),
      killReason:      killSwitch.getReason(),
      lastRun:         getState('last_run') || null,
      dailyPnl:        getDailyPnl(),
      consecutiveLoss: parseInt(getState('consecutive_losses') || '0'),
      totalTrades:     parseInt(getState('total_trades')       || '0'),
      totalWins:       parseInt(getState('total_wins')         || '0'),
      watchedSymbols:  (process.env.WATCHED_SYMBOLS || '').split(',').map(s => s.trim()),
      geminiStatus:    require('./ai/geminiNode').isAvailable() ? 'online' : 'circuit-open',
      uptime:          Math.floor(process.uptime()),
    });
  } catch (err) {
    // Fallback to env value if Alpaca API is unreachable
    logger.warn('Could not fetch live balance from Alpaca', { error: err.message });
    const mode    = process.env.TRADING_MODE || 'paper';
    const balance = mode === 'live'
      ? parseFloat(process.env.LIVE_ACCOUNT_BALANCE  || '5000')
      : parseFloat(process.env.PAPER_ACCOUNT_BALANCE || '100000');
    res.json({
      ok:              true,
      mode:            mode.toUpperCase(),
      balance,
      buyingPower:     null,
      cash:            null,
      equity:          null,
      killSwitch:      killSwitch.isActive(),
      killReason:      killSwitch.getReason(),
      lastRun:         getState('last_run') || null,
      dailyPnl:        getDailyPnl(),
      consecutiveLoss: parseInt(getState('consecutive_losses') || '0'),
      totalTrades:     parseInt(getState('total_trades')       || '0'),
      totalWins:       parseInt(getState('total_wins')         || '0'),
      watchedSymbols:  (process.env.WATCHED_SYMBOLS || '').split(',').map(s => s.trim()),
      geminiStatus:    'unknown',
      uptime:          Math.floor(process.uptime()),
      balanceSource:   'env_fallback',
    });
  }
});

/** Recent AI decisions */
app.get('/api/decisions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20'), 100);
  res.json(getRecentDecisions(limit));
});

/** Recent trades */
app.get('/api/trades', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20'), 100);
  res.json(getRecentTrades(limit));
});

/** Kill switch status */
app.get('/api/killswitch', (req, res) => {
  res.json({ active: killSwitch.isActive(), reason: killSwitch.getReason() });
});

/** Toggle kill switch */
app.post('/api/killswitch', (req, res) => {
  const { action, reason } = req.body;
  if (action === 'activate') {
    killSwitch.activate(reason || 'Manual activation via UI');
    logger.warn('Kill switch activated via API');
    res.json({ ok: true, active: true });
  } else if (action === 'deactivate') {
    killSwitch.deactivate();
    logger.info('Kill switch deactivated via API');
    res.json({ ok: true, active: false });
  } else {
    res.status(400).json({ error: 'action must be "activate" or "deactivate"' });
  }
});

/** Switch trading mode */
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['paper', 'live'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be paper or live' });
  }
  process.env.TRADING_MODE = mode;
  setState('trading_mode', mode);
  logger.info('Trading mode switched', { mode });
  res.json({ ok: true, mode });
});

/** Live account details from Alpaca */
app.get('/api/account', async (req, res) => {
  try {
    const account   = await alpacaClient.getAccount();
    const positions = await alpacaClient.getOpenPositions();
    res.json({ ok: true, account, positions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Open positions */
app.get('/api/positions', async (req, res) => {
  try {
    const positions = await alpacaClient.getOpenPositions();
    res.json(positions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Manually trigger one analysis cycle */
app.post('/api/run-now', async (req, res) => {
  logger.info('Manual cycle triggered via API');
  res.json({ ok: true, message: 'Event-driven system is always running — check /api/logs for activity' });
});

/** Fetch recent live logs */
const fs = require('fs');
app.get('/api/logs', (req, res) => {
  try {
    const logPath = path.join(__dirname, '../logs/combined.log');
    if (!fs.existsSync(logPath)) return res.json({ logs: [] });
    
    const stats = fs.statSync(logPath);
    const readSize = Math.min(stats.size, 10000); // Read last 10KB
    const fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);
    
    // Split by newline, remove empties, take last 30 lines
    const lines = buffer.toString('utf-8').split('\n').filter(Boolean).slice(-30);
    const parsed = lines.map(l => {
      try {
        const j = JSON.parse(l);
        const time = new Date(j.timestamp).toLocaleTimeString('en-US', { hour12: false });
        let msg = `[${time}] ${j.level}: ${j.message}`;
        delete j.timestamp; delete j.level; delete j.message;
        if (Object.keys(j).length) msg += ` ${JSON.stringify(j)}`;
        return msg;
      } catch(e) { return l; }
    });
    res.json({ logs: parsed });
  } catch (err) {
    res.json({ logs: ['Error reading logs: ' + err.message] });
  }
});

/** Serve control panel for any unmatched route */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─────────────────────────────────────────────
// Start Trading Engine
require('./autonomous/scheduler');
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`🌐 Control panel: http://localhost:${PORT}`);
  logger.info(`📊 Mode: ${(process.env.TRADING_MODE || 'paper').toUpperCase()}`);
});

module.exports = app;
