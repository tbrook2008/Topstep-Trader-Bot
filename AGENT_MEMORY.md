# AI Trader Prop Context & Memory

## Current State
- The bot is actively trading on a live $50K TopstepX Combine account.
- It operates entirely locally using PM2 (process name: `Topstep-Bot`) to comply with Topstep VPS/IP constraints.
- We have stripped out all LLM (Gemini/Ollama) consensus code, friends-node webhooks, and legacy statistical models (Kalman/OU/Ensemble). 

## Recent Architectural Shifts
- **Strategy Transition**: We abandoned the HMM/Kalman/OU pipeline because it over-traded and blew the daily loss limit. We have shifted 100% to a **VWAP Mean Reversion** strategy (`vwapReversion.js`).
- **Optimization Strategy**: The bot runs custom-tuned parameters for each ticker (stored in `server/data/symbolParams.json`).
- **API Guarding**: Added rigorous checks in `tradeExecutor.js` to ensure DRY_RUN testing/backtesting never spams the Topstep live API (which previously caused 429 errors).
- **Time Filter**: The bot executes only between 18:00 (Globex open) and 16:10 (market close), sleeping completely during the settlement window.
- **Contract Tracking**: The bot correctly targets micro futures (`MES`, `MNQ`, `MYM`, `M2K`, `MGC`, `MCL`, `ZB`) when tracking open positions and flattening.

## Important Constraints
- **Do not add Webhooks**: This bot must remain strictly isolated from the social/copy-trading API.
- **Topstep Daily Loss Limit (DLL)**: Never exceed the $1000 daily loss limit.
