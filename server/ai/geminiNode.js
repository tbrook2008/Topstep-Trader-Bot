require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

let _genAI = null;
function getGenAI() {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genAI;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
// When Gemini returns a 429 (rate limit / spending cap), we pause all Gemini
// calls for CIRCUIT_BREAK_MS to avoid spamming the API and error log.
const CIRCUIT_BREAK_MS = parseInt(process.env.GEMINI_CIRCUIT_BREAK_MS || '3600000'); // 1 hour default
let _circuitOpenUntil = 0;  // timestamp when we can try again
let _rateLimitLogged  = false;

function isCircuitOpen() {
  return Date.now() < _circuitOpenUntil;
}

function tripCircuit(reason) {
  _circuitOpenUntil = Date.now() + CIRCUIT_BREAK_MS;
  if (!_rateLimitLogged) {
    const resetAt = new Date(_circuitOpenUntil).toLocaleTimeString();
    logger.warn(`Gemini circuit breaker OPEN — will retry after ${resetAt}`, { reason });
    _rateLimitLogged = true;
  }
}

function resetCircuit() {
  if (_rateLimitLogged) {
    logger.info('Gemini circuit breaker CLOSED — resuming normal operation');
    _rateLimitLogged = false;
  }
  _circuitOpenUntil = 0;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

/**
 * Analyze a research bundle and return a structured regime classification thesis.
 * @returns {{ regime: string, confidence: number, thesis: string, keyRisk: string } | null}
 */
async function analyze(bundle) {
  // Circuit breaker check — skip Gemini entirely when rate-limited
  if (isCircuitOpen()) {
    return null; // null = node unavailable, weights redistribute to Ollama
  }

  // If circuit was previously open but has now expired, reset it
  if (_rateLimitLogged && !isCircuitOpen()) resetCircuit();

  const model = getGenAI().getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const isCrypto = bundle.isCrypto ?? false;
  const assetType = isCrypto
    ? 'CRYPTOCURRENCY (24/7 market, high volatility)'
    : 'EQUITY (NYSE/NASDAQ, Mon–Fri 9:30–16:00 ET)';

  const prompt = `
Analyze this market data for ${bundle.symbol} and return a JSON regime classification.

ASSET TYPE: ${assetType}

MARKET DATA:
- Current Price:   ${bundle.price}
- Day High/Low:    ${bundle.high} / ${bundle.low}
- Volume:          ${bundle.volume}

RECENT HEADLINES (${bundle.headlines.length}):
${bundle.headlines.slice(0, 6).map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n')}

${isCrypto ? 'NOTE: This is a crypto asset. Consider broader crypto market conditions.\n' : ''}
Return ONLY this JSON (no markdown, no explanation):
{
  "regime": <"momentum" | "mean-reverting">,
  "confidence": <integer 0-100>,
  "thesis": <2-3 sentence reasoning>,
  "key_risk": <one sentence on biggest risk>
}`;

  try {
    const result = await model.generateContent(prompt);
    const text   = result.response.text().trim();
    const parsed = JSON.parse(text);

    if (!parsed.regime || typeof parsed.confidence !== 'number') {
      throw new Error('Invalid response structure from Gemini');
    }

    logger.info('Gemini node complete', {
      symbol:     bundle.symbol,
      regime:     parsed.regime,
      confidence: parsed.confidence,
    });

    return {
      regime:     parsed.regime,
      confidence: Math.max(0, Math.min(100, parsed.confidence)),
      thesis:     parsed.thesis  ?? '',
      keyRisk:    parsed.key_risk ?? '',
    };

  } catch (err) {
    // ── Classify the error ──
    const msg = err.message || '';
    const is429        = msg.includes('429') || msg.includes('spending cap') || msg.includes('Too Many Requests');
    const isQuotaDaily = msg.includes('quota') && msg.includes('daily');
    const is404        = msg.includes('404') || msg.includes('not found');

    if (is429 || isQuotaDaily) {
      tripCircuit('spending_cap_or_rate_limit');
      // Downgraded to warn — this is expected when quota is exhausted
      // The circuit breaker suppresses future logs until reset
    } else if (is404) {
      logger.error('Gemini model not found — check GEMINI_MODEL in .env', {
        symbol: bundle.symbol,
        model:  process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      });
    } else {
      logger.error('Gemini node failed', { symbol: bundle.symbol, error: msg.slice(0, 120) });
    }

    return null;
  }
}

/**
 * Check if Gemini is currently circuit-broken (rate-limited).
 */
function isAvailable() {
  return !isCircuitOpen();
}

/**
 * Manually reset the circuit breaker (e.g., after billing quota resets).
 */
function forceReset() {
  resetCircuit();
}

module.exports = { analyze, isAvailable, forceReset };
