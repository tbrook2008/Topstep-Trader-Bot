require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');

const OLLAMA_BASE = () =>
  `http://${process.env.OLLAMA_DESKTOP_IP || 'localhost'}:${process.env.OLLAMA_PORT || 11434}`;

const TIMEOUT_MS = 30000; // Ollama can be slow on first run

const REGIME_PROMPT = (symbol, headlines) => `
You are a financial analyst for an autonomous trading system. Classify the market regime for ${symbol} as either "momentum" or "mean-reverting" based on these recent news headlines.

Few-Shot Examples for Calibration:
Example 1: "Company announces record quarterly profits and raises guidance" -> {"regime": "momentum", "confidence": 90, "summary": "Strong growth catalysts suggest a momentum regime"}
Example 2: "Market remains flat ahead of Fed rate decision" -> {"regime": "mean-reverting", "confidence": 80, "summary": "Lack of clear direction and macro uncertainty yield a mean-reverting regime"}

Current Headlines for ${symbol}:
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}

Respond with ONLY a JSON object in this exact format:
{"regime": <"momentum" | "mean-reverting">, "confidence": <integer 0 to 100>, "summary": "<one sentence>"}

ONLY output valid JSON. No explanation, no markdown.`;

const REFINE_PROMPT = (symbol, originalRegime, originalSummary, geminiThesis) => `
You are a financial sentiment analyst engaged in an AI Debate with a quantitative technical analyst.

Earlier, you classified the regime for ${symbol} as "${originalRegime}" based on news headlines. Your summary was: "${originalSummary}".

The technical analyst (Gemini) strongly disagrees based on their reading of the charts and technical data.
Here is Gemini's technical thesis:
"${geminiThesis}"

Your task is to re-evaluate your original regime classification in light of this conflicting technical data.
Do you stand your ground because the news is an overriding factor, or do you adjust your classification?

Respond with ONLY a JSON object in this exact format:
{"regime": <"momentum" | "mean-reverting">, "confidence": <integer 0 to 100>, "summary": "<one sentence explaining why you adjusted or kept your classification>"}

ONLY output valid JSON. No explanation, no markdown.`;

async function analyze(bundle) {
  const headlines = bundle.headlines.map(h => h.title).filter(Boolean);

  if (headlines.length === 0) {
    logger.warn('Ollama node: no headlines — returning mean-reverting', { symbol: bundle.symbol });
    return { regime: 'mean-reverting', confidence: 50, summary: 'No news available, defaulting to mean-reverting' };
  }

  try {
    const response = await axios.post(
      `${OLLAMA_BASE()}/api/generate`,
      {
        model: process.env.OLLAMA_MODEL || 'llama3.1',
        prompt: REGIME_PROMPT(bundle.symbol, headlines.slice(0, 8)),
        stream: false,
        options: { temperature: 0.1, num_predict: 100 },
      },
      { timeout: TIMEOUT_MS }
    );

    const raw = response.data?.response?.trim();
    if (!raw) throw new Error('Empty response from Ollama');

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Non-JSON Ollama response: ${raw.slice(0, 100)}`);

    const parsed = JSON.parse(jsonMatch[0]);

    logger.info('Ollama node complete', { symbol: bundle.symbol, regime: parsed.regime, confidence: parsed.confidence, summary: parsed.summary });
    return { regime: parsed.regime, confidence: parsed.confidence, summary: parsed.summary ?? '' };
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
      logger.warn('Ollama unreachable — node will be excluded from consensus', { symbol: bundle.symbol });
    } else {
      logger.error('Ollama node error', { symbol: bundle.symbol, error: err.message });
    }
    return null; // null = node failed, weight redistributes
  }
}

async function refine(bundle, originalResult, geminiResult) {
  try {
    logger.info('Ollama refinement pass triggered (AI Debate)', { symbol: bundle.symbol });
    const response = await axios.post(
      `${OLLAMA_BASE()}/api/generate`,
      {
        model: process.env.OLLAMA_MODEL || 'llama3.1',
        prompt: REFINE_PROMPT(bundle.symbol, originalResult.regime, originalResult.summary, geminiResult.thesis),
        stream: false,
        options: { temperature: 0.3, num_predict: 150 },
      },
      { timeout: TIMEOUT_MS }
    );

    const raw = response.data?.response?.trim();
    if (!raw) throw new Error('Empty response from Ollama during refinement');

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Non-JSON Ollama response: ${raw.slice(0, 100)}`);

    const parsed = JSON.parse(jsonMatch[0]);

    logger.info('Ollama refinement complete', { symbol: bundle.symbol, regime: parsed.regime, confidence: parsed.confidence, summary: parsed.summary });
    return { regime: parsed.regime, confidence: parsed.confidence, summary: parsed.summary ?? '' };
  } catch (err) {
    logger.error('Ollama refinement error, falling back to original score', { symbol: bundle.symbol, error: err.message });
    return originalResult;
  }
}

/**
 * Test Ollama connectivity — used by npm run test:ollama
 */
async function test() {
  const resp = await axios.get(`${OLLAMA_BASE()}/api/tags`, { timeout: 5000 });
  return { ok: true, models: resp.data?.models?.map(m => m.name) };
}

module.exports = { analyze, refine, test };
