/**
 * scratch/backtest_hybrid.js
 * 
 * Full backtest + parameter optimizer for the Hybrid Regime-Aware Strategy.
 * 
 * What it does:
 *   1. Fetches real 10-day 1-minute bar data from TopstepX for each symbol
 *   2. Sweeps a parameter grid (ADX threshold, TP/SL multipliers, vol ratio)
 *   3. Simulates bar-by-bar execution with slippage + commission
 *   4. Reports: win rate, profit factor, Sharpe, max drawdown, total P&L
 *   5. Writes the best params per symbol back to symbolParams.json
 * 
 * Run:
 *   node scratch/backtest_hybrid.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const topstepClient = require('../server/execution/topstepxClient');
const hybridStrategy = require('../server/quantitative/hybridStrategy');
const { classifyRegime } = require('../server/quantitative/hybridStrategy');
const fs   = require('fs');
const path = require('path');
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOLS = ['MNQ', 'MES', 'MGC'];
const FETCH_DAYS = 10;
const LIMIT = 5000;
const HISTORY_LIMIT = 200;
const COMMISSION_PER_SIDE = 0.50; // $ per contract per side (TopstepX micro rate)

// Dollar value per 1 point of price movement, per contract
const MULTIPLIERS = { MNQ: 2, MES: 5, MCL: 100, MGC: 10, MYM: 0.5, M2K: 5 };

// Session filter: RTH only (9:30 AM – 3:00 PM ET)
const SESSION_START_HOUR_ET = 9;
const SESSION_START_MIN_ET  = 30;
const SESSION_END_HOUR_ET   = 15;
const SESSION_END_MIN_ET    = 0;

// ─── Parameter grid ───────────────────────────────────────────────────────────

const GRID = {
  adxThreshold:    [18, 22, 25],
  trendTpMult:     [1.5, 2.0, 2.5],
  trendSlMult:     [0.8, 1.0, 1.2],
  minVolumeRatio:  [1.2, 1.5],
  // VWAP params (for ranging regime)
  sdMultiplier:    [2.5],        // keep fixed — already optimized
  rsiOversold:     [30],
  rsiOverbought:   [70],
  stopLossMultiplier: [1.5],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRTH(bar) {
  const ts = bar.timestamp || bar.time;
  const d  = typeof ts === 'string' ? new Date(ts) : new Date(ts * (ts < 1e12 ? 1000 : 1));
  const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const h = et.getHours();
  const m = et.getMinutes();
  const minuteOfDay = h * 60 + m;
  const startMin    = SESSION_START_HOUR_ET * 60 + SESSION_START_MIN_ET;
  const endMin      = SESSION_END_HOUR_ET   * 60 + SESSION_END_MIN_ET;
  return minuteOfDay >= startMin && minuteOfDay < endMin;
}

function cartesianProduct(grid) {
  const keys = Object.keys(grid);
  const vals = keys.map(k => grid[k]);
  const combos = vals.reduce((acc, arr) =>
    acc.flatMap(combo => arr.map(v => [...combo, v])), [[]]
  );
  return combos.map(combo => {
    const obj = {};
    keys.forEach((k, i) => { obj[k] = combo[i]; });
    return obj;
  });
}

function sharpeRatio(returns) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252 * 390); // annualised, 1-min bars
}

function maxDrawdown(equityCurve) {
  let peak = equityCurve[0] || 0;
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchHistoricalData(symbol) {
  console.log(`  Fetching ${symbol}...`);
  await topstepClient.authenticate();
  const contractId = await topstepClient.getContractId(symbol);
  if (!contractId) { console.warn(`  No contract ID for ${symbol}`); return []; }

  const now  = new Date();
  const past = new Date(now.getTime() - FETCH_DAYS * 24 * 60 * 60 * 1000);

  try {
    const response = await axios.post(
      `${topstepClient.baseUrl}/History/retrieveBars`,
      { contractId, live: false, startTime: past.toISOString(), endTime: now.toISOString(), unit: 2, unitNumber: 1, limit: LIMIT },
      { headers: topstepClient._getAuthHeaders() }
    );
    if (response.data && response.data.success && response.data.bars) {
      const bars = response.data.bars.reverse().map(b => ({
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
        timestamp: b.t, symbol
      }));
      console.log(`  Got ${bars.length} bars for ${symbol}`);
      return bars;
    }
  } catch (err) {
    console.error(`  Error fetching ${symbol}: ${err.message}`);
  }
  return [];
}

// ─── Single backtest run ──────────────────────────────────────────────────────

function runSingle(data, symbol, params) {
  const multiplier = MULTIPLIERS[symbol] || 2;

  let openPos    = null;
  let equity     = 0;
  let trades     = 0;
  let wins       = 0;
  let totalWinPts = 0;
  let totalLossPts = 0;
  const equityCurve = [0];
  const tradeReturns = [];
  let history = [];

  for (let i = 0; i < data.length; i++) {
    const bar = data[i];
    history.push(bar);
    if (history.length > HISTORY_LIMIT) history.shift();
    if (history.length < HISTORY_LIMIT) continue;

    // Manage open position first
    if (openPos) {
      let closed = false;
      let exitPts = 0;

      if (openPos.direction === 'LONG') {
        if (bar.low <= openPos.stopLoss) {
          exitPts  = openPos.stopLoss - openPos.entry; // negative
          closed   = true;
        } else if (bar.high >= openPos.takeProfit) {
          exitPts  = openPos.takeProfit - openPos.entry; // positive
          closed   = true;
          wins++;
        }
      } else {
        if (bar.high >= openPos.stopLoss) {
          exitPts  = openPos.entry - openPos.stopLoss; // negative
          closed   = true;
        } else if (bar.low <= openPos.takeProfit) {
          exitPts  = openPos.entry - openPos.takeProfit; // positive
          closed   = true;
          wins++;
        }
      }

      if (closed) {
        const pnl = exitPts * multiplier * openPos.qty - (2 * COMMISSION_PER_SIDE * openPos.qty);
        equity += pnl;
        equityCurve.push(equity);
        tradeReturns.push(pnl);
        trades++;
        if (pnl > 0) totalWinPts += Math.abs(exitPts) * multiplier;
        else totalLossPts += Math.abs(exitPts) * multiplier;
        openPos = null;
      }
      continue; // don't enter a new position while one is open
    }

    // Skip outside RTH
    if (!isRTH(bar)) continue;

    // Inject params for the strategy modules to pick up
    global.OPTIMIZE_PARAMS = params;

    const signal = hybridStrategy.evaluate(history, symbol);
    if (!signal) continue;

    // Only trade on meaningful signal with reasonable bracket
    const risk = Math.abs(signal.entry - signal.stopLoss);
    const reward = Math.abs(signal.target - signal.entry);
    if (risk === 0 || reward === 0) continue;
    const rr = reward / risk;
    if (rr < 1.2) continue; // minimum R:R gate

    openPos = {
      direction:  signal.action,
      entry:      signal.entry,
      stopLoss:   signal.stopLoss,
      takeProfit: signal.target,
      qty:        1,
      regime:     signal.regime || 'unknown',
      strategy:   signal.strategy || 'unknown'
    };
  }

  const winRate     = trades > 0 ? wins / trades : 0;
  const profitFactor = totalLossPts > 0 ? totalWinPts / totalLossPts : (totalWinPts > 0 ? Infinity : 0);
  const sharpe      = sharpeRatio(tradeReturns);
  const maxDD       = maxDrawdown(equityCurve);

  return { trades, wins, winRate, equity, profitFactor, sharpe, maxDD };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  HYBRID STRATEGY BACKTEST + OPTIMIZER');
  console.log('══════════════════════════════════════════════════════\n');

  const grid = cartesianProduct(GRID);
  console.log(`Parameter combinations per symbol: ${grid.length}`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}\n`);

  // Load existing symbolParams.json as base
  let symbolParams = {};
  const paramsPath = path.join(__dirname, '../server/data/symbolParams.json');
  try { symbolParams = JSON.parse(fs.readFileSync(paramsPath, 'utf-8')); } catch (_) {}

  let grandTrades = 0, grandWins = 0, grandEquity = 0;

  for (const symbol of SYMBOLS) {
    console.log(`\n─── ${symbol} ───────────────────────────────────────`);
    const data = await fetchHistoricalData(symbol);
    if (data.length < HISTORY_LIMIT + 50) {
      console.log(`  Not enough data (${data.length} bars). Skipping.\n`);
      continue;
    }

    let best = null;
    let bestScore = -Infinity;

    process.stdout.write(`  Sweeping ${grid.length} combos`);
    for (let ci = 0; ci < grid.length; ci++) {
      if (ci % 10 === 0) process.stdout.write('.');
      const params = grid[ci];
      const result = runSingle(data, symbol, params);

      // Score = Sharpe ratio, but only if profit factor > 1.2 and at least 5 trades
      if (result.trades >= 5 && result.profitFactor > 1.2 && result.equity > 0) {
        const score = result.sharpe + result.profitFactor;
        if (score > bestScore) {
          bestScore = score;
          best = { params, result };
        }
      }
    }
    console.log(' done');

    // Fall back to best equity if nothing passes the strict gate
    if (!best) {
      process.stdout.write('  (no combo met gate, picking best equity) ');
      let bestEq = -Infinity;
      for (const params of grid) {
        const result = runSingle(data, symbol, params);
        if (result.equity > bestEq) { bestEq = result.equity; best = { params, result }; }
      }
      console.log('');
    }

    if (best) {
      const { result, params } = best;
      const winRatePct = (result.winRate * 100).toFixed(1);
      console.log(`\n  ✅ BEST PARAMS for ${symbol}:`);
      console.log(`     adxThreshold:    ${params.adxThreshold}`);
      console.log(`     trendTpMult:     ${params.trendTpMult}`);
      console.log(`     trendSlMult:     ${params.trendSlMult}`);
      console.log(`     minVolumeRatio:  ${params.minVolumeRatio}`);
      console.log(`     sdMultiplier:    ${params.sdMultiplier}`);
      console.log(`     rsiOversold:     ${params.rsiOversold}`);
      console.log(`     rsiOverbought:   ${params.rsiOverbought}`);
      console.log(`     stopLossMultiplier: ${params.stopLossMultiplier}`);
      console.log(`\n  📊 BACKTEST RESULTS:`);
      console.log(`     Trades:          ${result.trades} (${result.wins}W / ${result.trades - result.wins}L)`);
      console.log(`     Win Rate:        ${winRatePct}%`);
      console.log(`     Profit Factor:   ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
      console.log(`     Net P&L:         $${result.equity.toFixed(2)}`);
      console.log(`     Max Drawdown:    $${result.maxDD.toFixed(2)}`);
      console.log(`     Sharpe (ann.):   ${result.sharpe.toFixed(3)}`);

      // Warn if results look too risky for the combine
      if (result.maxDD > 600) {
        console.log(`  ⚠️  Max drawdown $${result.maxDD.toFixed(2)} exceeds single-day $600 target.`);
      }
      if (result.winRate < 0.38) {
        console.log(`  ⚠️  Win rate ${winRatePct}% is low for the R:R ratio.`);
      }

      // Merge best params into symbolParams (keep VWAP params from existing config)
      symbolParams[symbol] = {
        ...(symbolParams[symbol] || {}),
        ...params
      };

      grandTrades += result.trades;
      grandWins   += result.wins;
      grandEquity += result.equity;
    }
  }

  // Write updated params
  fs.writeFileSync(paramsPath, JSON.stringify(symbolParams, null, 2));
  console.log(`\n✅ symbolParams.json updated with backtest-optimized parameters.`);

  const grandWR = grandTrades > 0 ? ((grandWins / grandTrades) * 100).toFixed(1) : '0.0';
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  PORTFOLIO SUMMARY');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Total Trades:    ${grandTrades}`);
  console.log(`  Overall Win Rate: ${grandWR}%`);
  console.log(`  Combined Net P&L: $${grandEquity.toFixed(2)}`);
  console.log('\nDone. Review results above before going live.');
  console.log('══════════════════════════════════════════════════════\n');

  global.OPTIMIZE_PARAMS = null; // reset injection
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
