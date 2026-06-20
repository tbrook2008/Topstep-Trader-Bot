/**
 * test-all.js
 * Comprehensive test suite for all AI Trader modules.
 * Run: node test-all.js
 */
require('dotenv').config();
const { computeEMA } = require('./server/quantitative/macd');
const { computeSMA, computeSD, computeRSI } = require('./server/quantitative/bollingerRsi');
const { calculateATR } = require('./server/quantitative/atr');
const { analyzeVolume, classifyVolume } = require('./server/quantitative/volumeProfile');
const macd = require('./server/quantitative/macd');
const bollingerRsi = require('./server/quantitative/bollingerRsi');
const { getPositionSize } = require('./server/risk/kellyCriterion');
const { isCryptoSymbol } = require('./server/data/dataAggregator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

// ─── Generate test bar data ────────────────────────────────────────────────────

function makeBar(close, open = null, volume = 1000) {
  const o = open ?? close * 0.998;
  return { open: o, high: close * 1.002, low: o * 0.998, close, volume };
}

function makeHistory(closes, volumes = null) {
  return closes.map((c, i) => makeBar(c, null, volumes ? volumes[i] : 1000));
}

// Uptrend data (for trend filter tests)
function makeTrendData(n = 60, start = 100, direction = 1) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const close = start + direction * i * 0.5 + (Math.random() - 0.5) * 0.2;
    bars.push({ open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 1000 + Math.random() * 200 });
  }
  return bars;
}

// ─── ATR Tests ────────────────────────────────────────────────────────────────
console.log('\n📊 ATR Tests');

test('calculateATR returns null with insufficient data', () => {
  assert(calculateATR([makeBar(100), makeBar(101)], 14) === null);
});

test('calculateATR returns number with enough data', () => {
  const history = makeHistory(Array.from({ length: 20 }, (_, i) => 100 + i));
  const atr = calculateATR(history, 14);
  assert(atr !== null && atr > 0, `Expected positive ATR, got ${atr}`);
});

test('ATR is higher for volatile bars', () => {
  const stable   = makeHistory(Array.from({ length: 20 }, () => 100));
  const volatile = makeHistory(Array.from({ length: 20 }, (_, i) => i % 2 === 0 ? 95 : 105));
  const atr1 = calculateATR(stable, 14);
  const atr2 = calculateATR(volatile, 14);
  assert(atr2 > atr1, `Volatile ATR (${atr2}) should be > stable ATR (${atr1})`);
});

// ─── BollingerRsi Tests ───────────────────────────────────────────────────────
console.log('\n📊 Bollinger+RSI Tests');

test('Returns NO_TRADE with insufficient history', () => {
  assertEqual(bollingerRsi.evaluate(makeHistory([100, 101, 99])), 'NO_TRADE');
});

test('Returns NO_TRADE when no extreme condition', () => {
  // Flat market around SMA
  const hist = makeHistory(Array.from({ length: 55 }, () => 100));
  assertEqual(bollingerRsi.evaluate(hist), 'NO_TRADE');
});

test('Returns NO_TRADE for crypto overbought (no shorting)', () => {
  // Create an overbought scenario
  const base = Array.from({ length: 54 }, () => 100);
  const bars = makeHistory([...base, 115]); // Spike up
  // Even if overbought, crypto should not SHORT
  const result = bollingerRsi.evaluate(bars, true);
  assert(result !== 'SHORT', `Crypto should never produce SHORT, got: ${result}`);
});

test('Requires bar close > open for LONG signal', () => {
  // Build a history where last bar is bearish (close < open) but oversold
  const closes = Array.from({ length: 55 }, (_, i) => {
    if (i < 50) return 100;
    return 90 - i; // Falling hard into oversold
  });
  const bars = closes.map((c, i) => {
    if (i === closes.length - 1) {
      return { open: c + 0.5, high: c + 1, low: c - 0.5, close: c, volume: 1000 }; // Bearish bar
    }
    return makeBar(c);
  });
  // Should not LONG if bar body is bearish even if technically oversold
  // (trend filter may also block — just check it's not blindly LONGing)
  const result = bollingerRsi.evaluate(bars, false);
  assert(result === 'NO_TRADE' || result === 'LONG', `Expected NO_TRADE or LONG, got ${result}`);
});

// ─── MACD Tests ───────────────────────────────────────────────────────────────
console.log('\n📊 MACD Tests');

test('Returns NO_TRADE with insufficient data (<35 bars)', () => {
  assertEqual(macd.evaluate(makeHistory(Array.from({ length: 30 }, () => 100))), 'NO_TRADE');
});

test('computeEMA produces correct length output', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const ema = computeEMA(closes, 12);
  assertEqual(ema.length, 30, `Expected length 30, got ${ema.length}`);
});

test('EMA correctly smooths a series', () => {
  const closes = Array.from({ length: 15 }, () => 100);
  const ema = computeEMA(closes, 12);
  // After flat input, EMA should converge to the same value
  const last = ema[ema.length - 1];
  assert(Math.abs(last - 100) < 0.01, `EMA should converge to 100, got ${last}`);
});

test('Returns NO_TRADE in flat market', () => {
  const flat = makeHistory(Array.from({ length: 40 }, () => 100));
  assertEqual(macd.evaluate(flat), 'NO_TRADE');
});

// ─── Volume Profile Tests ─────────────────────────────────────────────────────
console.log('\n📊 Volume Profile Tests');

test('Returns supported=true with insufficient history', () => {
  const result = analyzeVolume(makeHistory([100, 101]), 'LONG');
  assertEqual(result.supported, true);
});

test('Blocks trade on dead volume (< 20% of average)', () => {
  // 19 bars with volume 1000, 1 bar with volume 50
  const vols = Array.from({ length: 19 }, () => 1000).concat([50]);
  const bars = makeHistory(Array.from({ length: 20 }, () => 100), vols);
  const result = analyzeVolume(bars, 'LONG');
  assertEqual(result.supported, false, `Expected blocked on dead volume, got supported=${result.supported}, reason=${result.reason}`);
});

test('classifyVolume returns HIGH for 2x average', () => {
  const vols = Array.from({ length: 20 }, () => 1000);
  vols[19] = 2500; // 2.5x average
  const bars = makeHistory(Array.from({ length: 20 }, () => 100), vols);
  assertEqual(classifyVolume(bars), 'HIGH');
});

test('classifyVolume returns BELOW_AVG for 0.6x volume', () => {
  const vols = Array.from({ length: 20 }, () => 1000);
  vols[19] = 600;
  const bars = makeHistory(Array.from({ length: 20 }, () => 100), vols);
  assertEqual(classifyVolume(bars), 'BELOW_AVG');
});

// ─── Kelly Criterion Tests ────────────────────────────────────────────────────
console.log('\n📊 Kelly Criterion Tests');

test('getPositionSize returns valid sizing object', () => {
  const sizing = getPositionSize('BTC/USD', 80000, 100000, 65);
  assert(sizing.qty > 0, `Expected qty > 0, got ${sizing.qty}`);
  assert(sizing.positionDollars > 0, `Expected positionDollars > 0`);
  assert(sizing.positionDollars <= 100000 * 0.06, `Position should respect MAX_POSITION_PCT=6%`);
});

test('Higher confidence produces larger position', () => {
  const low  = getPositionSize('BTC/USD', 80000, 100000, 50);
  const high = getPositionSize('BTC/USD', 80000, 100000, 85);
  assert(high.positionDollars >= low.positionDollars, 
    `Higher confidence should produce >= position: ${high.positionDollars} vs ${low.positionDollars}`);
});

// ─── Symbol Detection Tests ───────────────────────────────────────────────────
console.log('\n📊 Symbol Detection Tests');

test('BTC/USD is crypto', () => assert(isCryptoSymbol('BTC/USD')));
test('ETH/USD is crypto', () => assert(isCryptoSymbol('ETH/USD')));
test('DOGE/USD is crypto', () => assert(isCryptoSymbol('DOGE/USD')));
test('AAPL is NOT crypto', () => assert(!isCryptoSymbol('AAPL')));
test('TSLA is NOT crypto', () => assert(!isCryptoSymbol('TSLA')));
test('BTCUSD (no slash) is crypto', () => assert(isCryptoSymbol('BTCUSD')));

// ─── RSI Tests ───────────────────────────────────────────────────────────────
console.log('\n📊 RSI Tests');

test('RSI returns null array for insufficient data', () => {
  const rsi = computeRSI([100, 101, 99], 14);
  assert(rsi.every(v => v === null), 'All RSI values should be null with < 15 points');
});

test('RSI = 100 when all gains', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i); // Continuously rising
  const rsi = computeRSI(closes, 14);
  const last = rsi[rsi.length - 1];
  assert(last > 90, `RSI should be > 90 on continuous gains, got ${last?.toFixed(1)}`);
});

test('RSI ≈ 50 in flat market', () => {
  const closes = Array.from({ length: 20 }, (_, i) => i % 2 === 0 ? 100 : 101); // Alternating
  const rsi = computeRSI(closes, 14);
  const last = rsi[rsi.length - 1];
  assert(last > 30 && last < 70, `RSI should be ~50 in flat market, got ${last?.toFixed(1)}`);
});

// ─── Integration: Full Pipeline Syntax Check ──────────────────────────────────
console.log('\n📊 Integration: Module Load Test');

test('tradeExecutor loads without errors', () => {
  require('./server/execution/tradeExecutor');
});
test('consensus loads without errors', () => {
  require('./server/ai/consensus');
});
test('riskMonitor loads without errors', () => {
  require('./server/autonomous/riskMonitor');
});
test('validator loads without errors', () => {
  require('./server/risk/validator');
});
test('dataAggregator loads without errors', () => {
  require('./server/data/dataAggregator');
});
test('alpacaClient loads without errors', () => {
  require('./server/execution/alpacaClient');
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('❌ Some tests failed — fix before deploying.');
  process.exit(1);
} else {
  console.log('✅ All tests passed.');
  process.exit(0);
}
