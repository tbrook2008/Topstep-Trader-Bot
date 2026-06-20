const { getState, setState } = require('../db/schema');
const logger = require('../utils/logger');

function isActive() {
  return getState('kill_switch') === 'true';
}

function activate(reason = 'Manual activation') {
  setState('kill_switch', 'true');
  setState('kill_switch_reason', reason);
  logger.warn('🚨 KILL SWITCH ACTIVATED', { reason });
}

function deactivate() {
  setState('kill_switch', 'false');
  setState('kill_switch_reason', '');
  logger.info('✅ Kill switch deactivated — trading resumed');
}

function getReason() {
  return getState('kill_switch_reason') || '';
}

/**
 * Auto-checks daily PnL against Prop Firm strict limits.
 * Enforces both the $800 Daily Loss Limit AND the $1200 Consistency Profit Cap.
 */
function autoCheckDailyLimits(dailyPnl) {
  const maxLossUsd = parseFloat(process.env.MAX_DAILY_LOSS_USD || '800');
  const maxProfitUsd = 1200; // Hardcoded Topstep 50k consistency cap

  if (dailyPnl <= -maxLossUsd && !isActive()) {
    activate(`Auto: Daily loss limit hit ($${dailyPnl.toFixed(2)} / -$${maxLossUsd.toFixed(2)})`);
    return true;
  }
  
  if (dailyPnl >= maxProfitUsd && !isActive()) {
    activate(`Auto: Daily Consistency Profit Cap hit! ($${dailyPnl.toFixed(2)}). Shutting down for the day to protect 50% rule.`);
    return true;
  }
  return false;
}

module.exports = { isActive, activate, deactivate, getReason, autoCheckDailyLimits };
