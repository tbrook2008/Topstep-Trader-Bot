process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Database setup
const db = new sqlite3.Database(path.join(__dirname, '../data/friends.sqlite'));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    alpaca_key TEXT,
    alpaca_secret TEXT,
    is_active BOOLEAN DEFAULT 1
  )`);
});

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_dev_key';

// Global Execution Queue to prevent 429 Rate Limits from concurrent webhooks
let executionQueue = Promise.resolve();

// Internal Webhook from Master AI Trader
app.post('/api/internal/signal', async (req, res) => {
  // Security: You might want to add an internal IP check or basic auth token here
  const { symbol, direction, price, qty, trailPrice, targetPrice, isTrending } = req.body;
  
  if (!symbol || !direction || !price) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log(`[WEBHOOK] Queued signal from Master: ${direction} ${symbol} @ ${price}`);
  res.json({ status: 'Broadcast queued' }); // Respond immediately so Master isn't blocked

  executionQueue = executionQueue.then(() => new Promise((resolve) => {
    db.all(`SELECT alpaca_key, alpaca_secret FROM users WHERE is_active = 1`, [], async (err, users) => {
      if (err) {
        console.error('DB Error fetching users for signal');
        return resolve();
      }
      
      let successCount = 0;
      for (const user of users) {
        if (!user.alpaca_key || !user.alpaca_secret) continue;
        
        const alpaca = new Alpaca({
          keyId: user.alpaca_key,
          secretKey: user.alpaca_secret,
          paper: true
        });
        
        try {
          const account = await alpaca.getAccount();
          
          if (direction === 'CLOSE') {
            await alpaca.closePosition(symbol);
          } else {
            const positionPct = req.body.positionPct || 0.05;
            const positionDollars = parseFloat(account.buying_power) * positionPct;
            const calculatedQty = Math.max(1, Math.floor(positionDollars / price));
            
            await alpaca.createOrder({
              symbol,
              qty: calculatedQty,
              side: direction === 'LONG' ? 'buy' : 'sell',
              type: 'market',
              time_in_force: 'gtc'
            });
          }
          
          console.log(`[EXECUTION] Completed ${direction} on ${symbol} for ${user.alpaca_key.slice(0,5)}...`);
          successCount++;
        } catch (e) {
          console.error(`Failed to execute for user: ${e.message}`);
        }
        
        // 2000ms delay between individual API calls across ALL signals globally
        await new Promise(res => setTimeout(res, 2000));
      }
      
      console.log(`[WEBHOOK] Finished executing ${direction} ${symbol}. Users hit: ${successCount}`);
      resolve();
    });
  })).catch(e => console.error("Queue execution error:", e));
});

// Basic API endpoints for dashboard (Auth & Settings)
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.run(`INSERT INTO users (username, password_hash) VALUES (?, ?)`, [username, hash], function(err) {
    if (err) return res.status(400).json({ error: 'Username taken' });
    res.json({ success: true });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  });
});

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// User Endpoints
app.post('/api/user/keys', authenticateToken, (req, res) => {
  const { key, secret } = req.body;
  db.run(`UPDATE users SET alpaca_key = ?, alpaca_secret = ? WHERE id = ?`, [key, secret, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB Error' });
    res.json({ success: true });
  });
});

app.get('/api/user/portfolio', authenticateToken, (req, res) => {
  db.get(`SELECT alpaca_key, alpaca_secret FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    if (!user || !user.alpaca_key || !user.alpaca_secret) {
      return res.json({ equity: 0, buying_power: 0, connected: false });
    }
    
    try {
      const alpaca = new Alpaca({
        keyId: user.alpaca_key,
        secretKey: user.alpaca_secret,
        paper: true
      });
      const account = await alpaca.getAccount();
      
      // Fetch recent orders to populate the executions table
      const orders = await alpaca.getOrders({
        status: 'all',
        limit: 10,
        direction: 'desc'
      });
      
      const formattedOrders = orders.map(o => ({
        id: o.id,
        asset: o.symbol,
        side: o.side.toUpperCase(),
        qty: o.qty,
        price: o.filled_avg_price || o.limit_price || 'Market',
        status: o.status,
        timestamp: new Date(o.created_at).toLocaleTimeString()
      }));

      res.json({ 
        equity: account.equity, 
        buying_power: account.buying_power,
        recent_orders: formattedOrders,
        connected: true 
      });
    } catch (e) {
      res.status(400).json({ error: 'Invalid API Keys' });
    }
  });
});

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[AI Trader - Execution Node] Listening on port ${PORT}`);
});
