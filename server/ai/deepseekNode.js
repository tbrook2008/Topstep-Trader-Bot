require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');

const DEEPSEEK_URL = `${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'}/chat/completions`;

const SYSTEM_PROMPT = `You are a macro risk analyst and trading strategist. Your job is to evaluate trade proposals from a risk perspective.
You receive technical analysis (from Gemini) and sentiment data (from local LLM) and must provide your independent assessment.
Always respond with valid JSON only. Be skeptical — err on the side of caution.`;

async function analyze(bundle, geminiResult, ollamaSentiment) {
  const prompt = `
Evaluate this trade opportunity for ${bundle.symbol}.

TECHNICAL ANALYSIS (from Gemini):
- Score: ${geminiResult?.score ?? 'N/A'} / 100
- Direction: ${geminiResult?.direction ?? 'N/A'}
- Confidence: ${geminiResult?.confidence ?? 'N/A'}%
- Thesis: ${geminiResult?.thesis ?? 'N/A'}
- Key Risk: ${geminiResult?.keyRisk ?? 'N/A'}

NEWS SENTIMENT (from local LLM):
- Score: ${ollamaSentiment?.sentiment ?? 'N/A'} (range: -1.0 to 1.0)
- Summary: ${ollamaSentiment?.summary ?? 'N/A'}

MARKET CONTEXT:
- Price: ${bundle.price}, Change: ${bundle.changePct?.toFixed(2)}%
- RSI: ${bundle.rsi14 ?? 'N/A'}, Trend: ${bundle.trend}, Regime: ${bundle.regime}
- Recent Headlines: ${bundle.headlines.slice(0, 4).map(h => h.title).join(' | ')}

Your task: Provide an INDEPENDENT macro/risk assessment. 

Consider:
1. Does the technical analysis align with macro conditions?
2. Are there any red flags in the news sentiment?
3. Is the risk/reward ratio acceptable?
4. What is the broader market context suggesting?

Respond ONLY with this JSON (no markdown):
{
  "score": <integer -100 to 100>,
  "direction": <"LONG" | "SHORT" | "NO_TRADE">,
  "risk_level": <"LOW" | "MEDIUM" | "HIGH">,
  "agrees_with_gemini": <boolean>,
  "recommendation": "<one paragraph reasoning>",
  "red_flags": ["<flag1>", "<flag2>"] 
}`;

  try {
    const response = await axios.post(
      DEEPSEEK_URL,
      {
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty DeepSeek response');

    const parsed = JSON.parse(raw);
    if (typeof parsed.score !== 'number') throw new Error('Invalid score in DeepSeek response');

    logger.info('DeepSeek node complete', {
      symbol: bundle.symbol,
      score: parsed.score,
      direction: parsed.direction,
      riskLevel: parsed.risk_level,
      agreesWithGemini: parsed.agrees_with_gemini,
    });

    return {
      score:           Math.max(-100, Math.min(100, parsed.score)),
      direction:        parsed.direction ?? 'NO_TRADE',
      riskLevel:        parsed.risk_level ?? 'MEDIUM',
      agreesWithGemini: parsed.agrees_with_gemini ?? false,
      recommendation:   parsed.recommendation ?? '',
      redFlags:         parsed.red_flags ?? [],
    };
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('DeepSeek rate limited — node excluded from consensus', { symbol: bundle.symbol });
    } else {
      logger.error('DeepSeek node failed', { symbol: bundle.symbol, error: err.message });
    }
    return null; // null = graceful exclusion
  }
}

module.exports = { analyze };
