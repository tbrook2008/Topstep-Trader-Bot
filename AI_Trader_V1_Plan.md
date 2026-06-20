# AI Trader — V1 Validation Plan

**Philosophy:** Prove the core signal works before building anything on top of it.
The original 30-task plan is a great *roadmap*, but not a *starting point*.
This plan gets you to a running, observable system in days — not a finished one.

---

## The V1 Goal (Single Sentence)

Run the bare system in paper mode for 3–4 weeks and answer one question:
**"Does the Tri-Node Consensus generate directionally correct signals more than 50% of the time?"**

If yes → start building Phase 1 enhancements.
If no → fix the signal before adding any complexity.

---

## Stage 1: Get It Running (Day 1–2)

### 1.1 — Environment Setup
- Copy `.env.template` → `.env`
- Fill in **only** what's needed to run:
  - `GEMINI_API_KEY`
  - `OLLAMA_MODEL` (whatever `ollama list` shows)
  - `DEEPSEEK_API_KEY`
  - `ALPACA_API_KEY` + `ALPACA_SECRET_KEY`
  - `TRADING_MODE=paper`
  - `PAPER_ACCOUNT_BALANCE=100000`
  - `LOG_HMAC_SECRET` (generate with the command in WINDOWS_SETUP.md)
- Leave everything else at defaults

### 1.2 — Smoke Tests (Run in Order)
```bash
npm run test:db        # Database initializes cleanly
npm run test:data      # Yahoo Finance returns quotes
npm run test:ollama    # Ollama responds
npm run test:kelly     # Position sizing math is correct
npm run dry-run        # Full cycle runs without crashing
```
**Stop here if any test fails.** Fix before moving on.

### 1.3 — One Watchlist Symbol to Start
Don't let the system trade 20 tickers on Day 1.
Pick **one liquid, boring stock** (e.g., SPY or AAPL) and configure the watchlist to only include that.
This makes it easy to observe and reason about what the system is doing.

---

## Stage 2: Instrument for Observability (Day 2–3)

Before running live paper trades, make sure you can *see* what the system is doing.
You need answers to these questions after every cycle:

- What did each AI node recommend?
- What confidence score did each node return?
- Did the consensus reach the approval threshold?
- If a trade was placed, what size? At what price?
- If no trade was placed, why not?

### 2.1 — Verify Logging Is Detailed Enough
Check that `server/db/tradeLogger.js` records:
- Each node's individual recommendation and confidence
- Final consensus direction + confidence
- Reason for NO_TRADE if applicable
- Intended vs actual fill price

If any of these are missing, add them before running. You cannot improve what you cannot see.

### 2.2 — Add a Simple Decision Log Viewer
Add one endpoint to `server/index.js` if it doesn't exist:

```javascript
// GET /api/decisions?limit=20
// Returns last N decision records from DB, most recent first
app.get('/api/decisions', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const rows = db.prepare(
    'SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
  res.json(rows);
});
```

This is your most important debugging tool. Check it after every cycle.

### 2.3 — Check the Kill Switch Works
Manually trigger kill switch conditions and verify it actually stops trading.
Do not assume it works — test it.

---

## Stage 3: Minimal Risk Rails (Day 3)

You don't need all of Phase 1. You need just enough to not blow up the paper account while you're observing.

### 3.1 — Verify Kelly Is Actually Being Applied
Run `npm run test:kelly` and confirm the position size it returns is sensible.
For a $100,000 paper account, no single trade should be more than **$5,000 (5%)** while you're validating.
If Kelly is returning larger sizes, lower `KELLY_FRACTION_DIVISOR` until it doesn't.

### 3.2 — Set a Hard Daily Loss Limit
Make sure kill switch triggers if daily paper P&L drops below -2%.
That's $2,000 on a $100K paper account. Verify this is configured and working.

### 3.3 — Confirm Paper Mode Cannot Accidentally Go Live
Check `server/execution/alpacaClient.js` and confirm that when `TRADING_MODE=paper`,
it uses Alpaca's paper endpoint, not the live one. This is critical.

---

## Stage 4: Run & Observe (Weeks 1–3)

### 4.1 — What to Watch Every Day
Each morning, check `/api/decisions` from the previous day and ask:

1. **Node agreement**: Are all 3 nodes generally agreeing, or constantly split?
   - Constant disagreement → the prompt design or data input may be unclear
   - Too much agreement → nodes may be parroting each other (check if they're getting identical context)

2. **Confidence calibration**: Are confidence scores spread across the range (50–95%), or clustering at one value (e.g., all 75%)?
   - Clustering → the model isn't differentiating between strong and weak signals

3. **Signal direction**: When a LONG signal fires, does the stock actually go up that day?
   - Track this manually in a spreadsheet for the first 2 weeks
   - You need at least 30 signals to have statistical meaning

4. **NO_TRADE rate**: What % of cycles result in no trade?
   - 80–90% NO_TRADE is healthy for a conservative system
   - 50% NO_TRADE means the approval threshold is too low
   - 99% NO_TRADE means the system is almost never confident enough

### 4.2 — Weekly Review Checklist
At the end of each week, record:

| Metric | Week 1 | Week 2 | Week 3 |
|--------|--------|--------|--------|
| Total signals fired | | | |
| LONG signals | | | |
| SHORT signals | | | |
| Win rate (signal was correct) | | | |
| NO_TRADE % | | | |
| Paper P&L ($) | | | |
| Paper P&L (%) | | | |
| Largest single loss | | | |
| Kill switch triggered? | | | |

### 4.3 — Red Flags to Watch For

**Stop trading immediately and investigate if:**
- Paper account drops more than 5% in a week
- Kill switch triggers more than once in a week
- Two nodes consistently contradict the third (one node may be broken)
- The same trade is recommended and rejected repeatedly (validator loop)

---

## Stage 5: Go / No-Go Decision (End of Week 3)

After 3 weeks and at least **20 completed trades**, evaluate:

| Criteria | Minimum Threshold | Notes |
|----------|-------------------|-------|
| Signal win rate | ≥ 50% | Directionally correct more often than not |
| Paper P&L | Positive, or < -3% | Deep losses mean signal is anti-correlated |
| Node agreement rate | ≥ 60% of cycles | Nodes generally agree |
| Largest single drawdown | < 5% of account | Risk rails working |
| System uptime | > 95% | No recurring crashes |

**If all criteria pass:** Begin implementing Phase 1 from the original plan (starting with confidence-scaled position sizing and ATR stops).

**If signal win rate is below 50%:** The core issue is the AI prompt design or the data being fed to the nodes. Fix this before building anything else. Common causes:
- Prompts are too vague — nodes aren't given enough structure to make specific predictions
- News sentiment context is stale or noisy
- The 15-minute cycle is too frequent for the kind of analysis LLMs do well

**If system is crashing:** Fix stability before worrying about performance.

---

## What You Are NOT Building in V1

Explicitly deferred until signal is validated:

- ATR-based stops (use static 2% for now)
- Confidence-scaled position sizing (use flat Kelly for now)
- Market regime detection
- Mean reversion signals
- Pairs trading
- Backtesting framework
- A/B testing
- Earnings drift
- Order book signals
- Anything in Phases 2–8

This isn't permanent — it's disciplined sequencing.

---

## V1 File Checklist

Nothing new to build. Just verify these work:

```
server/
├── ai/
│   ├── consensus.js        ✓ Returns direction + confidence
│   ├── geminiNode.js       ✓ Responds to test:ollama equivalent
│   ├── ollamaNode.js       ✓ Responds to npm run test:ollama
│   └── deepseekNode.js     ✓ Responds correctly
├── data/
│   └── yahooFinance.js     ✓ Returns quotes (npm run test:data)
├── execution/
│   ├── tradeExecutor.js    ✓ Places paper orders
│   └── validator.js        ✓ Rejects invalid trades with logged reason
├── risk/
│   ├── kellyCriterion.js   ✓ Math is correct (npm run test:kelly)
│   └── killSwitch.js       ✓ Triggers on daily loss limit
├── db/
│   ├── schema.js           ✓ Initializes cleanly (npm run test:db)
│   └── tradeLogger.js      ✓ Records node decisions and outcomes
└── autonomous/
    ├── loop.js             ✓ Completes cycle without crashing
    └── scheduler.js        ✓ Runs on correct interval
```

---

## The Honest Benchmark

After 3 weeks of paper trading, the system should be able to answer this:

> "In the last 20+ trades, the consensus signal was directionally correct X% of the time,
> with an average paper return of Y% per trade and a max drawdown of Z%."

If X > 52%, Y > 0, and Z < 5%, you have a signal worth building on.
If not, you have valuable information that saves you from building 30 features on top of a broken foundation.

---

*V1 Plan | AI Trader | Generated March 2026*
*Next phase: AI_Trader_Phase1_Enhancements.md (after V1 validation passes)*
