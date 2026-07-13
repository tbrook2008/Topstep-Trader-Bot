require('dotenv').config();
const killSwitch = require('./killSwitch');
const { getState } = require('../db/schema');
const { getDailyPnl } = require('../db/tradeLogger');
const { isCryptoSymbol } = require('../data/dataAggregator');
const { checkCorrelation } = require('./correlation');
const logger = require('../utils/logger');

const MIN_CONFIDENCE   = parseFloat(process.env.APPROVAL_THRESHOLD       || '62');
const MAX_CONSEC_LOSS  = parseInt(process.env.MAX_CONSECUTIVE_LOSSES     || '3');
const MAX_EXPOSURE_PCT = 0.40;   // 40% max total portfolio exposure (tightened from 50%)
const MAX_POSITION_PCT = parseFloat(process.env.MAX_POSITION_PCT         || '0.06');
const COOLDOWN_MIN     = parseInt(process.env.COOLDOWN_MINUTES            || '30');
const MAX_DAILY_LOSS   = parseFloat(process.env.MAX_DAILY_LOSS_PCT        || '0.03');

/**
 * Run all 11 pre-trade safety checks.
 * Returns { passed: boolean, failed: string[], checks: object[] }
 */
async function runChecks({ consensus, symbol, positionDollars, alpacaAccount, openPositions, liveBalance = null }) {
  const isLive      = (process.env.TRADING_MODE || 'paper') === 'live';
  // Use live balance from Alpaca API if provided; fall back to env for test scripts
  const balance     = liveBalance ?? (isLive
    ? parseFloat(process.env.LIVE_ACCOUNT_BALANCE  || '5000')
    : parseFloat(process.env.PAPER_ACCOUNT_BALANCE || '100000'));
  const dailyPnl    = getDailyPnl();
  const consecLoss  = parseInt(getState('consecutive_losses') || '0');
  const lastRunStr  = getState(`last_trade_${symbol}`) || '';
  const lastRunMs   = lastRunStr ? new Date(lastRunStr).getTime() : 0;
  // Post-loss cooldown multiplier: double the wait after each consecutive loss
  const cooldownMultiplier = consecLoss > 0 ? Math.min(consecLoss + 1, 3) : 1;
  const effectiveCooldown  = COOLDOWN_MIN * cooldownMultiplier;
  const minsAgo     = (Date.now() - lastRunMs) / 60000;

  // Total open exposure
  const openExposure = openPositions
    ? openPositions.reduce((sum, p) => sum + Math.abs(parseFloat(p.marketValue || 0)), 0)
    : 0;

  // Compute Correlation
  const correlationPass = await checkCorrelation(symbol);

  // Auto-enforce Prop Firm Limits (Daily Loss, Consistency Cap)
  killSwitch.autoCheckDailyLimits(dailyPnl);

  const checks = [
    {
      name: 'Kill Switch OFF',
      passed: !killSwitch.isActive(),
      detail: killSwitch.isActive() ? killSwitch.getReason() : 'OK',
    },
    {
      name: 'Consensus Approved',
      passed: consensus.approved === true,
      detail: consensus.reason,
    },
    {
      name: 'No Crypto Shorting',
      passed: !(isCryptoSymbol(symbol) && consensus.direction === 'SHORT'),
      detail: 'Alpaca does not support short selling cryptocurrencies',
    },
    {
      name: 'Absolute Minimum Balance Guard ($48,500)',
      passed: balance > 48500,
      detail: `Current balance ($${balance}) must stay above $48,500. Below $48,000 = Topstep MLL breach and account termination.`,
    },

    {
      name: `Consecutive Losses < ${MAX_CONSEC_LOSS}`,
      passed: consecLoss < MAX_CONSEC_LOSS,
      detail: `Current streak: ${consecLoss}`,
    },
    {
      name: 'Daily Loss < $900 (Topstep DLL Protection)',
      passed: dailyPnl > -900,
      detail: `Daily PnL: $${dailyPnl.toFixed(2)} / hard limit: -$900 (Topstep DLL is -$1,000)`,
    },
    {
      name: 'Total Exposure < 50%',
      passed: openExposure < balance * MAX_EXPOSURE_PCT,
      detail: `Open exposure: $${openExposure.toFixed(0)} / limit: $${(balance * MAX_EXPOSURE_PCT).toFixed(0)}`,
    },
    {
      name: `Position Size ≤ ${MAX_POSITION_PCT * 100}% of balance`,
      passed: positionDollars <= balance * MAX_POSITION_PCT,
      detail: `Position: $${positionDollars.toFixed(0)} / max: $${(balance * MAX_POSITION_PCT).toFixed(0)}`,
    },
    {
      name: `Cooldown ≥ ${COOLDOWN_MIN} min (×${Math.min(consecLoss + 1, 3)} after ${consecLoss} loss(es))`,
      passed: lastRunMs === 0 || minsAgo >= effectiveCooldown,
      detail: lastRunMs === 0 ? 'First trade' : `${minsAgo.toFixed(0)} min ago (need ${effectiveCooldown.toFixed(0)} min)`,
    },
    {
      name: 'No existing open position',
      passed: !openPositions?.some(p => {
        // Normalize both sides: Alpaca may return BTC/USD or BTCUSD for crypto
        const normalize = (s) => (s || '').replace(/[/-]/, '').toUpperCase();
        return normalize(p.symbol) === normalize(symbol);
      }),
      detail: `Checking ${symbol} in ${openPositions?.length ?? 0} open positions`,
    },
    {
      name: 'Correlation Guard',
      passed: correlationPass,
      detail: correlationPass ? 'No high correlation with open positions' : 'Rejected due to high correlation with an open position',
    },
    {
      name: 'Topstep Scaling Rule (Max 4 positions)',
      passed: (openPositions ? openPositions.length : 0) < 4,
      detail: `Currently holding ${openPositions ? openPositions.length : 0} open positions. Prop firm limit is 5.`,
    },
  ];

  // PDT Rule does not apply to futures accounts — Topstep is a CME futures account.

  const failed = checks.filter(c => !c.passed).map(c => c.name);
  const passed = failed.length === 0;

  if (!passed) {
    logger.warn('Pre-trade checks FAILED', { symbol, failed });
  } else {
    logger.info('Pre-trade checks PASSED', { symbol, checksRun: checks.length });
  }

  return { passed, failed, checks };
}

module.exports = { runChecks };
