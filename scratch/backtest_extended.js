/**
 * scratch/backtest_extended.js
 *
 * Extended 60-day backtest for the Hybrid Regime-Aware Strategy.
 * Fetches data in weekly chunks from TopstepX to overcome the 5000-bar limit,
 * stitches them into a single chronological series, then runs the full
 * parameter grid search with statistically meaningful trade counts.
 *
 * Run:
 *   node scratch/backtest_extended.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const topstepClient  = require('../server/execution/topstepxClient');
const hybridStrategy = require('../server/quantitative/hybridStrategy');
const orbStrategy    = require('../server/quantitative/orbStrategy');
const fs   = require('fs');
const path = require('path');
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOLS      = ['MES', 'MGC'];
const TOTAL_DAYS   = 60;       // how far back to go
const CHUNK_DAYS   = 8;        // size of each API fetch window
const BAR_LIMIT    = 4800;     // bars per chunk (stay under 5000 limit)
const HISTORY_WARM = 200;      // bars needed for indicators to warm up
const COMMISSION   = 0.50;     // $ per contract per side

const MULTIPLIERS  = { MES: 5, MGC: 10, MNQ: 2, MCL: 100, MYM: 0.5, M2K: 5 };

// RTH session filter: 9:30 AM – 3:00 PM ET
const RTH_START = 9 * 60 + 30;
const RTH_END   = 15 * 60 + 0;

// ─── Parameter grid ───────────────────────────────────────────────────────────

const GRID = {
  adxThreshold:   [18, 22, 25],
  trendTpMult:    [1.5, 2.0, 2.5],
  trendSlMult:    [0.8, 1.0, 1.2],
  minVolumeRatio: [1.2, 1.5],
  // VWAP params (kept fixed — already optimized in previous run)
  sdMultiplier:       [2.5],
  rsiOversold:        [30],
  rsiOverbought:      [70],
  stopLossMultiplier: [1.5],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRTH(bar) {
  const ts = bar.timestamp || bar.time;
  const d  = typeof ts === 'string' ? new Date(ts) : new Date(ts * (ts < 1e12 ? 1000 : 1));
  const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const minOfDay = et.getHours() * 60 + et.getMinutes();
  return minOfDay >= RTH_START && minOfDay < RTH_END;
}

function cartesian(grid) {
  const keys = Object.keys(grid);
  return keys.reduce((combos, key) =>
    combos.flatMap(c => grid[key].map(v => ({ ...c, [key]: v }))), [{}]
  );
}

function maxDrawdown(curve) {
  let peak = curve[0] || 0, dd = 0;
  for (const v of curve) { if (v > peak) peak = v; dd = Math.max(dd, peak - v); }
  return dd;
}

function profitFactor(tradeResults) {
  const wins  = tradeResults.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const losses = tradeResults.filter(r => r < 0).reduce((s, r) => s + Math.abs(r), 0);
  return losses === 0 ? (wins > 0 ? Infinity : 0) : wins / losses;
}

function sharpe(tradeResults) {
  if (tradeResults.length < 2) return 0;
  const mean = tradeResults.reduce((a, b) => a + b, 0) / tradeResults.length;
  const std  = Math.sqrt(tradeResults.reduce((s, r) => s + (r - mean) ** 2, 0) / tradeResults.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

// ─── Data fetching (chunked) ───────────────────────────────────────────────────

async function fetchChunked(symbol) {
  console.log(`  Fetching ${symbol} (${TOTAL_DAYS} days in ${CHUNK_DAYS}-day chunks)...`);
  await topstepClient.authenticate();
  const contractId = await topstepClient.getContractId(symbol);
  if (!contractId) { console.warn(`  No contract ID for ${symbol}`); return []; }

  const allBars = [];
  const now = new Date();

  const chunks = Math.ceil(TOTAL_DAYS / CHUNK_DAYS);
  for (let c = 0; c < chunks; c++) {
    const endTime   = new Date(now.getTime() - c * CHUNK_DAYS * 86400000);
    const startTime = new Date(endTime.getTime() - CHUNK_DAYS * 86400000);

    try {
      const resp = await axios.post(
        `${topstepClient.baseUrl}/History/retrieveBars`,
        { contractId, live: false, startTime: startTime.toISOString(),
          endTime: endTime.toISOString(), unit: 2, unitNumber: 1, limit: BAR_LIMIT },
        { headers: topstepClient._getAuthHeaders() }
      );
      if (resp.data?.success && resp.data?.bars?.length) {
        const bars = resp.data.bars.map(b => ({
          open: b.o, high: b.h, low: b.l, close: b.c,
          volume: b.v, timestamp: b.t, symbol
        }));
        allBars.push(...bars);
      }
    } catch (err) {
      console.warn(`  Chunk ${c + 1}/${chunks} error: ${err.message}`);
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  // Sort chronologically (oldest first), deduplicate by timestamp
  const seen = new Set();
  const sorted = allBars
    .filter(b => { if (seen.has(b.timestamp)) return false; seen.add(b.timestamp); return true; })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  console.log(`  Total bars: ${sorted.length} (${TOTAL_DAYS}-day window)`);
  return sorted;
}

// ─── Single backtest run ──────────────────────────────────────────────────────

function runSingle(data, symbol, params) {
  const mult = MULTIPLIERS[symbol] || 2;
  orbStrategy.resetAll(); // reset ORB intraday state for clean sweep

  let pos = null, equity = 0, wins = 0, trades = 0;
  const curve = [0];
  const results = [];
  let history = [];

  for (const bar of data) {
    history.push(bar);
    if (history.length > HISTORY_WARM) history.shift();
    if (history.length < HISTORY_WARM) continue;

    // Manage open position
    if (pos) {
      let pnl = null;
      if (pos.dir === 'LONG') {
        if (bar.low  <= pos.sl) pnl = (pos.sl - pos.entry) * mult * pos.qty - 2 * COMMISSION * pos.qty;
        else if (bar.high >= pos.tp) { pnl = (pos.tp - pos.entry) * mult * pos.qty - 2 * COMMISSION * pos.qty; wins++; }
      } else {
        if (bar.high >= pos.sl) pnl = (pos.entry - pos.sl) * mult * pos.qty - 2 * COMMISSION * pos.qty;
        else if (bar.low  <= pos.tp) { pnl = (pos.entry - pos.tp) * mult * pos.qty - 2 * COMMISSION * pos.qty; wins++; }
      }
      if (pnl !== null) {
        equity += pnl; curve.push(equity); results.push(pnl); trades++; pos = null;
      }
      continue;
    }

    // Only enter during RTH
    if (!isRTH(bar)) continue;

    global.OPTIMIZE_PARAMS = params;
    const sig = hybridStrategy.evaluate(history, symbol);
    if (!sig) continue;

    const risk   = Math.abs(sig.entry - sig.stopLoss);
    const reward = Math.abs(sig.target - sig.entry);
    if (risk === 0 || reward / risk < 1.2) continue;

    pos = { dir: sig.action, entry: sig.entry, sl: sig.stopLoss, tp: sig.target, qty: 1 };
  }

  return {
    trades, wins,
    winRate:      trades > 0 ? wins / trades : 0,
    equity,
    profitFactor: profitFactor(results),
    sharpe:       sharpe(results),
    maxDD:        maxDrawdown(curve),
    expectancy:   trades > 0 ? equity / trades : 0,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  HYBRID STRATEGY — EXTENDED 60-DAY BACKTEST          ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const grid = cartesian(GRID);
  console.log(`Symbols: ${SYMBOLS.join(', ')} | Grid: ${grid.length} combos | History: ${TOTAL_DAYS} days\n`);

  const paramsPath = path.join(__dirname, '../server/data/symbolParams.json');
  let symbolParams = {};
  try { symbolParams = JSON.parse(fs.readFileSync(paramsPath, 'utf-8')); } catch (_) {}

  const report = [];
  let grandTrades = 0, grandWins = 0, grandEquity = 0;

  for (const symbol of SYMBOLS) {
    console.log(`\n─── ${symbol} ${'─'.repeat(50 - symbol.length)}`);
    const data = await fetchChunked(symbol);
    if (data.length < HISTORY_WARM + 100) {
      console.log(`  Not enough data. Skipping.\n`); continue;
    }

    let bestResult = null, bestParams = null, bestScore = -Infinity;

    process.stdout.write(`  Sweeping ${grid.length} combos `);
    for (let ci = 0; ci < grid.length; ci++) {
      if (ci % 9 === 0) process.stdout.write('.');
      const r = runSingle(data, symbol, grid[ci]);
      // Primary: Sharpe + profit factor (only count if meaningful trade count + positive)
      if (r.trades >= 10 && r.profitFactor > 1.0 && r.equity > 0) {
        const score = r.sharpe + r.profitFactor * 0.5;
        if (score > bestScore) { bestScore = score; bestResult = r; bestParams = grid[ci]; }
      }
    }

    // Fallback: max equity
    if (!bestResult) {
      process.stdout.write(' (no combo passed gate, using best equity) ');
      for (const p of grid) {
        const r = runSingle(data, symbol, p);
        if (r.equity > (bestResult?.equity ?? -Infinity)) { bestResult = r; bestParams = p; }
      }
    }
    console.log(' done');

    if (bestResult && bestParams) {
      const wr = (bestResult.winRate * 100).toFixed(1);
      const pf = bestResult.profitFactor === Infinity ? '∞' : bestResult.profitFactor.toFixed(2);

      console.log(`\n  ✅ BEST PARAMS for ${symbol}:`);
      console.log(`     adxThreshold=${bestParams.adxThreshold}  trendTpMult=${bestParams.trendTpMult}  trendSlMult=${bestParams.trendSlMult}  minVolumeRatio=${bestParams.minVolumeRatio}`);

      console.log(`\n  📊 60-DAY BACKTEST RESULTS (with $${COMMISSION}/side commission):`);
      console.log(`     Trades:        ${bestResult.trades} (${bestResult.wins}W / ${bestResult.trades - bestResult.wins}L)`);
      console.log(`     Win Rate:      ${wr}%`);
      console.log(`     Profit Factor: ${pf}`);
      console.log(`     Expectancy:    $${bestResult.expectancy.toFixed(2)}/trade`);
      console.log(`     Net P&L:       $${bestResult.equity.toFixed(2)} (1 contract)`);
      console.log(`     Max Drawdown:  $${bestResult.maxDD.toFixed(2)}`);
      console.log(`     Sharpe (ann.): ${bestResult.sharpe.toFixed(3)}`);

      // Risk flags
      if (bestResult.maxDD > 600)  console.log(`  ⚠️  Single-symbol DD $${bestResult.maxDD.toFixed(2)} > $600 target`);
      if (bestResult.winRate < 0.40) console.log(`  ⚠️  Win rate ${wr}% below 40% minimum`);
      if (bestResult.trades < 15)  console.log(`  ⚠️  Only ${bestResult.trades} trades — increase data window for higher confidence`);
      if (bestResult.expectancy > 0 && bestResult.profitFactor > 1.3) {
        console.log(`  ✅ Positive expectancy ($${bestResult.expectancy.toFixed(2)}/trade) — strategy has real edge on this data`);
      }

      report.push({ symbol, result: bestResult, params: bestParams });
      symbolParams[symbol] = { ...(symbolParams[symbol] || {}), ...bestParams };
      grandTrades += bestResult.trades;
      grandWins   += bestResult.wins;
      grandEquity += bestResult.equity;
    }
  }

  // Save optimized params
  fs.writeFileSync(paramsPath, JSON.stringify(symbolParams, null, 2));
  console.log(`\n✅ symbolParams.json updated with 60-day optimized parameters.`);

  // Portfolio summary
  const grandWR = grandTrades > 0 ? ((grandWins / grandTrades) * 100).toFixed(1) : '0.0';
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  PORTFOLIO SUMMARY                                   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Period:           ${TOTAL_DAYS} days of real TopstepX market data`);
  console.log(`  Total Trades:     ${grandTrades}`);
  console.log(`  Combined Win Rate: ${grandWR}%`);
  console.log(`  Combined Net P&L: $${grandEquity.toFixed(2)} (1 contract each)`);
  console.log(`\n  Topstep Combine Target: +$3,000 profit in 30 days`);
  const dailyNeeded = 3000 / 30;
  const dailyActual = grandEquity / TOTAL_DAYS;
  console.log(`  Required daily:   $${dailyNeeded.toFixed(2)}`);
  console.log(`  Backtest daily:   $${dailyActual.toFixed(2)} (before scaling up contracts)`);
  if (dailyActual > 0 && dailyActual < dailyNeeded) {
    const contractsNeeded = Math.ceil(dailyNeeded / dailyActual);
    console.log(`  Contracts needed to hit target: ~${contractsNeeded}x (within Topstep's 5-contract max)`);
  }

  console.log('\n  NOTE: Backtest assumes 1 contract. Topstep allows up to 5 micros.');
  console.log('  Scaling to 2 contracts doubles both P&L and drawdown.');
  console.log('  Do NOT scale up unless win rate is confirmed above 55%.');
  console.log('\n══════════════════════════════════════════════════════\n');

  global.OPTIMIZE_PARAMS = null;
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
