/**
 * server/quantitative/orbStrategy.js
 *
 * Opening Range Breakout (ORB) Strategy
 * =====================================================================
 * One of the most battle-tested intraday futures strategies.
 *
 * Rules:
 *   1. Define the opening range: HIGH and LOW of the first 30 minutes
 *      of RTH (9:30 AM – 10:00 AM ET)
 *   2. After 10:00 AM ET, watch for the FIRST clean breakout:
 *      - Price closes ABOVE the range high → LONG
 *      - Price closes BELOW the range low  → SHORT
 *   3. Stop loss: opposite side of the range (+ small ATR buffer)
 *   4. Take profit: 1.5× the range width from entry
 *   5. One trade per symbol per day only
 *   6. Skip if range is wider than 2× ATR (news-driven gap, too risky)
 *
 * Works well because:
 *   - Institutions set positions in the first 30 minutes
 *   - A clean break beyond that range = directional conviction
 *   - Completely uncorrelated with MACD/VWAP signals (different time of day)
 */

const { calculateATR } = require('./atr');

// ─── Per-symbol intraday state (resets each trading day) ─────────────────────
// Used in live trading. Backtest calls resetState() between parameter sweeps.

const _state = {};

function getState(symbol) {
  if (!_state[symbol]) {
    _state[symbol] = { date: null, rangeHigh: null, rangeLow: null, tradedToday: false };
  }
  return _state[symbol];
}

function resetState(symbol) {
  _state[symbol] = { date: null, rangeHigh: null, rangeLow: null, tradedToday: false };
}

function resetAll() {
  Object.keys(_state).forEach(s => resetState(s));
}

// ─── Time utilities ────────────────────────────────────────────────────────────

function getETInfo(timestamp) {
  const ts = typeof timestamp === 'string' ? timestamp : new Date(timestamp * (timestamp < 1e12 ? 1000 : 1)).toISOString();
  const d  = new Date(ts);
  const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  return {
    minuteOfDay: et.getHours() * 60 + et.getMinutes(),
    dateKey: `${et.getFullYear()}-${et.getMonth()}-${et.getDate()}`
  };
}

const RANGE_START = 9 * 60 + 30;  // 9:30 AM ET
const RANGE_END   = 10 * 60;      // 10:00 AM ET
const TRADE_END   = 14 * 60 + 30; // 2:30 PM ET — stop looking for ORB entries

// ─── Main evaluate function ────────────────────────────────────────────────────

/**
 * Call this on every new bar. Updates range state and returns a signal
 * when a clean opening range breakout is detected.
 *
 * @param {Array}  history - OHLCV bars (oldest first)
 * @param {string} symbol
 * @returns {Object|null} signal object or null
 */
function evaluate(history, symbol) {
  if (!history || history.length < 30) return null;

  const lastBar = history[history.length - 1];
  if (!lastBar.timestamp) return null;

  const { minuteOfDay, dateKey } = getETInfo(lastBar.timestamp);
  const st = getState(symbol);

  // ── Reset state on new trading day ──
  if (st.date !== dateKey) {
    st.date        = dateKey;
    st.rangeHigh   = null;
    st.rangeLow    = null;
    st.tradedToday = false;
  }

  // ── During opening range window: build the range ──
  if (minuteOfDay >= RANGE_START && minuteOfDay < RANGE_END) {
    st.rangeHigh = st.rangeHigh === null ? lastBar.high : Math.max(st.rangeHigh, lastBar.high);
    st.rangeLow  = st.rangeLow  === null ? lastBar.low  : Math.min(st.rangeLow,  lastBar.low);
    return null; // still building the range, no signals yet
  }

  // ── Outside trading window ──
  if (minuteOfDay < RANGE_START || minuteOfDay > TRADE_END) return null;

  // ── Range must be defined ──
  if (st.rangeHigh === null || st.rangeLow === null) return null;

  // ── One trade per day only ──
  if (st.tradedToday) return null;

  const rangeWidth = st.rangeHigh - st.rangeLow;
  if (rangeWidth <= 0) return null;

  // ── Range sanity check: skip if range is wider than 2× ATR (gap/news day) ──
  const atr = calculateATR(history, 14);
  if (atr && rangeWidth > 2.5 * atr) return null;

  // ── Need previous bar to confirm clean breakout (close, not just wick) ──
  if (history.length < 2) return null;
  const prevBar = history[history.length - 2];
  const { minuteOfDay: prevMin } = getETInfo(prevBar.timestamp);

  // Previous bar must also be after range end (avoid first-bar false fires)
  if (prevMin < RANGE_END) return null;

  const price = lastBar.close;
  const buf   = atr ? 0.05 * atr : 0.02 * rangeWidth; // tiny ATR buffer on stop

  // ── LONG breakout ──
  if (lastBar.close > st.rangeHigh && prevBar.close <= st.rangeHigh) {
    st.tradedToday = true;
    const stopLoss = st.rangeLow - buf;
    const target   = price + 1.5 * rangeWidth;
    const risk     = price - stopLoss;
    const reward   = target - price;
    if (risk <= 0 || reward / risk < 1.0) return null;
    return {
      action:     'LONG',
      entry:      price,
      stopLoss,
      target,
      regime:     'opening_range',
      strategy:   'ORB',
      rangeHigh:  st.rangeHigh,
      rangeLow:   st.rangeLow,
      rangeWidth: rangeWidth.toFixed(4)
    };
  }

  // ── SHORT breakout ──
  if (lastBar.close < st.rangeLow && prevBar.close >= st.rangeLow) {
    st.tradedToday = true;
    const stopLoss = st.rangeHigh + buf;
    const target   = price - 1.5 * rangeWidth;
    const risk     = stopLoss - price;
    const reward   = price - target;
    if (risk <= 0 || reward / risk < 1.0) return null;
    return {
      action:     'SHORT',
      entry:      price,
      stopLoss,
      target,
      regime:     'opening_range',
      strategy:   'ORB',
      rangeHigh:  st.rangeHigh,
      rangeLow:   st.rangeLow,
      rangeWidth: rangeWidth.toFixed(4)
    };
  }

  return null;
}

module.exports = { evaluate, resetState, resetAll };
