# AI Trader — Windows Deployment Guide

## Prerequisites

### 1. Install Node.js (if not already installed)
- Download from https://nodejs.org — get the **LTS version**
- Verify: open PowerShell and run `node -v` (should show v18+)

### 2. Verify Ollama is working
```powershell
ollama list        # See installed models — note the model name
ollama run llama3  # Quick test (Ctrl+C to exit)
```

---

## Step 1: Transfer the Project

Copy the `AI Trader` folder from your Mac to your Windows desktop.

**Options:**
- USB drive
- Shared network folder
- Git (see bottom of this file)

Make sure the `AI Trader` folder ends up somewhere like:
```
C:\Users\YourName\Desktop\AI Trader\
```

---

## Step 2: Install Dependencies

Open PowerShell **in the AI Trader folder**:
```powershell
cd "C:\Users\YourName\Desktop\AI Trader"
npm install
```

This installs all packages. May take 1–2 minutes the first time.

---

## Step 3: Configure Your .env

Copy the template:
```powershell
copy .env.template .env
```

Open `.env` in Notepad and fill in:

```env
# Gemini
GEMINI_API_KEY=AIzaSy...

# Ollama — it's LOCAL on this machine
OLLAMA_DESKTOP_IP=localhost
OLLAMA_PORT=11434
OLLAMA_MODEL=llama3          # ← Use whatever "ollama list" showed you

# DeepSeek
DEEPSEEK_API_KEY=sk-...

# Alpaca — PAPER first
ALPACA_API_KEY=PK...
ALPACA_SECRET_KEY=...
TRADING_MODE=paper           # Change to "live" only when ready

# Balances
PAPER_ACCOUNT_BALANCE=100000
LIVE_ACCOUNT_BALANCE=5000

# HMAC secret — generate one:
# Open PowerShell: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
LOG_HMAC_SECRET=paste_generated_secret_here
```

---

## Step 4: Test Each Component

Run these in PowerShell to verify everything connects:

```powershell
# Test database
npm run test:db

# Test Yahoo Finance data
npm run test:data

# Test Ollama connectivity
npm run test:ollama

# Test Kelly sizing
npm run test:kelly

# Full dry run (no trades placed)
npm run dry-run
```

---

## Step 5: Run the System

### Option A: Manual start (for now)
```powershell
# Start the control panel server + scheduler together
npm start
```
Then open: **http://localhost:3000**

### Option B: Run as a Windows background service (24/7 recommended)

Install `pm2` globally:
```powershell
npm install -g pm2
npm install -g pm2-windows-startup
```

Start and save:
```powershell
pm2 start server/index.js --name "ai-trader-api"
pm2 start server/autonomous/scheduler.js --name "ai-trader-loop"
pm2 save
pm2-startup install
```

Now the trader starts automatically when Windows boots.

**PM2 commands:**
```powershell
pm2 status              # See both processes
pm2 logs ai-trader-loop # Live log stream
pm2 stop all            # Emergency stop
pm2 restart all         # Restart
```

---

## Step 6: Remote Access from Your Mac (Tailscale)

To control the trader from your Mac when away:

1. Download Tailscale on **Windows**: https://tailscale.com/download/windows
2. Download Tailscale on **Mac**: https://tailscale.com/download/mac
3. Sign in to the same Tailscale account on both
4. On Windows, run `tailscale ip` — note the IP (e.g. `100.x.x.x`)
5. On Mac browser: **http://100.x.x.x:3000**

That's it — works from anywhere in the world.

> **Note:** Keep Tailscale running on Windows. It auto-starts with Windows by default.

---

## Git Setup (optional, for keeping Mac/Windows in sync)

```powershell
# On Windows — init or clone
git init
git add .
git commit -m "Initial deploy"

# To pull updates from Mac:
git pull origin main
```

Never commit `.env` — it's in `.gitignore`.

---

## Quick Reference

| Command | What it does |
|---------|-------------|
| `npm start` | Start API server only |
| `npm run loop` | Start autonomous scheduler only |
| `npm run dry-run` | Full cycle, no trades placed |
| `pm2 status` | Check if both processes are running |
| `pm2 logs ai-trader-loop` | Watch live trading decisions |

## Control Panel

| URL | Purpose |
|-----|---------|
| `http://localhost:3000` | Local access |
| `http://TAILSCALE_IP:3000` | Remote from Mac |

---

## Troubleshooting

**Ollama not connecting:**
```powershell
curl http://localhost:11434/api/tags
# Should return list of models
```

**Alpaca auth errors:**
- Double-check you're using PAPER keys with `ALPACA_PAPER_URL`
- Paper keys and live keys are different in Alpaca dashboard

**Yahoo Finance errors:**
- Usually transient — the module retries automatically
- If persistent, check your internet connection

**DeepSeek 402 error:**
- Free-tier credits exhausted — add credits at platform.deepseek.com
- The consensus will still run with just Gemini + Ollama (2 nodes)

**`node-gyp` errors during `npm install`:**
- `better-sqlite3` needs build tools
- Run: `npm install --global windows-build-tools` (as Administrator)
- Or install Visual Studio Build Tools from Microsoft
