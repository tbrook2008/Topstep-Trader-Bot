# AI Trader Context & Memory
This file contains the context of the AI Trader project so that cloud agents can pick up where the local agent left off.

## Current State
- The bot has been deployed to the remote DigitalOcean droplet.
- PM2 is used for process management (process name: 'AI-Trader').
- A GitHub two-way sync workflow is in place. You can use 'git clone', 'git push', 'git pull' to synchronize.
- An hourly cron job is configured to verify PM2 status, monitor logs for errors, and calculate recent PnL from the local SQLite db.

## Recent Fixes
- **Pure Quantitative Pipeline:** The AI (Gemini/Ollama) consensus layer has been completely removed. The bot now runs entirely on advanced mathematical models.
- **Regime Detection:** Replaced ADX with a Gaussian Mixture Model (GMM) approximating a Hidden Markov Model (HMM) to classify market regimes based on log-returns volatility.
- **Momentum Trigger:** Replaced MACD and VWAP with a dynamic State-Space Kalman Filter that tracks price velocity and confirms with volume spikes.
- **Mean-Reversion Trigger:** Replaced Bollinger Bands and RSI with an Ornstein-Uhlenbeck (OU) process calibrated via exact linear regression to buy oversold Z-score deviations.
- Crypto Execution Fix: 'isCryptoSymbol' in 'alpacaClient.js' and 'dataAggregator.js' was updated to handle crypto symbols (e.g., BCH/USD). Alpaca does not support bracket orders for crypto; market orders must be used.
- Universal Risk Monitor Refactor: 'riskMonitor.js' automatically 'adopts' orphaned or manually opened positions from Alpaca that aren't in the local database. It logs these into the 'trades' table to reflect on the web dashboard.
- 'trader.sqlite' is the source of truth. If cleared, the dashboard won't show active trades until 'riskMonitor.js' adopts them.


## Important Constraint
- This bot trades real money. Slip-ups cannot happen. Make sure all changes are tested, and any orphaned positions are closely tracked and exited for profit.

When starting a new task, always refer to this memory file to understand the architecture and constraints.
