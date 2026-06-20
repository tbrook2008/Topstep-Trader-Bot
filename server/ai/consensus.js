require('dotenv').config();
const geminiNode   = require('./geminiNode');
const ollamaNode   = require('./ollamaNode');
const logger       = require('../utils/logger');

const WEIGHTS = {
  gemini: parseFloat(process.env.WEIGHT_GEMINI || '0.65'),
  ollama: parseFloat(process.env.WEIGHT_OLLAMA || '0.35'),
};

// When only 1 node is available, require higher confidence from that node alone
const APPROVAL_THRESHOLD        = parseFloat(process.env.APPROVAL_THRESHOLD || '62');
const SINGLE_NODE_THRESHOLD     = parseFloat(process.env.SINGLE_NODE_THRESHOLD || '72');

// ─── Weight redistribution ────────────────────────────────────────────────────

function redistributeWeights(results) {
  const available = Object.entries(results).filter(([, v]) => v !== null);
  if (available.length < 1) return null;

  const totalWeight = available.reduce((sum, [k]) => sum + WEIGHTS[k], 0);
  const adjustedWeights = {};
  for (const [k] of available) {
    adjustedWeights[k] = WEIGHTS[k] / totalWeight;
  }
  return { adjustedWeights, availableNodes: available.map(([k]) => k) };
}

// ─── Regime resolution ────────────────────────────────────────────────────────

function resolveRegime(nodeResults, adjustedWeights) {
  let momentumScore     = 0;
  let meanRevertingScore = 0;

  if (nodeResults.gemini) {
    const w = adjustedWeights.gemini;
    if (nodeResults.gemini.regime === 'momentum') momentumScore     += nodeResults.gemini.confidence * w;
    else                                           meanRevertingScore += nodeResults.gemini.confidence * w;
  }

  if (nodeResults.ollama) {
    const w = adjustedWeights.ollama;
    if (nodeResults.ollama.regime === 'momentum') momentumScore     += nodeResults.ollama.confidence * w;
    else                                          meanRevertingScore += nodeResults.ollama.confidence * w;
  }

  if (momentumScore > meanRevertingScore) {
    return { regime: 'momentum',       compositeConfidence: parseFloat(momentumScore.toFixed(2)) };
  } else {
    return { regime: 'mean-reverting', compositeConfidence: parseFloat(meanRevertingScore.toFixed(2)) };
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runConsensus(bundle) {
  logger.info('Starting regime consensus pipeline', { symbol: bundle.symbol });

  const geminiAvailable = geminiNode.isAvailable();

  // Always run Ollama — it's free, local, and fast
  let ollamaResult = await ollamaNode.analyze(bundle);

  // Only call Gemini if it's not circuit-broken
  let geminiResult = null;
  if (geminiAvailable) {
    geminiResult = await geminiNode.analyze(bundle);
  } else {
    logger.warn('Gemini circuit breaker active — Ollama-only consensus', { symbol: bundle.symbol });
  }

  // AI Debate: if both nodes ran and strongly disagree, have Ollama refine its position
  if (geminiResult && ollamaResult) {
    if (
      geminiResult.regime !== ollamaResult.regime &&
      Math.max(geminiResult.confidence, ollamaResult.confidence) > 70
    ) {
      logger.info('Significant AI disagreement — triggering debate/refinement', { symbol: bundle.symbol });
      ollamaResult = await ollamaNode.refine(bundle, ollamaResult, geminiResult);
    }
  }

  const rawResults = { gemini: geminiResult, ollama: ollamaResult };

  const info = redistributeWeights(rawResults);
  if (!info) {
    logger.warn('Consensus aborted — all nodes failed', { symbol: bundle.symbol });
    return {
      approved:       false,
      reason:         'All AI nodes unavailable',
      compositeScore: 0,
      compositeConfidence: 0,
      regime:         'UNKNOWN',
      nodeResults:    rawResults,
      nodesUsed:      [],
    };
  }

  const { adjustedWeights, availableNodes } = info;
  const { regime, compositeConfidence } = resolveRegime(rawResults, adjustedWeights);

  // Single-node mode requires higher confidence — less reliable without cross-check
  const isSingleNode     = availableNodes.length === 1;
  const effectiveThreshold = isSingleNode ? SINGLE_NODE_THRESHOLD : APPROVAL_THRESHOLD;
  const approved         = compositeConfidence >= effectiveThreshold;

  if (isSingleNode) {
    logger.warn(`Single-node consensus (${availableNodes[0]}) — threshold raised to ${effectiveThreshold}`, {
      symbol: bundle.symbol,
      score:  compositeConfidence,
    });
  }

  const result = {
    approved,
    compositeScore:      compositeConfidence,
    compositeConfidence,
    regime,
    threshold:           effectiveThreshold,
    isSingleNode,
    nodesUsed:           availableNodes,
    adjustedWeights,
    rawScores: {
      gemini: geminiResult?.confidence ?? null,
      ollama: ollamaResult?.confidence ?? null,
    },
    nodeResults: rawResults,
    reason: approved
      ? `Confidence ${compositeConfidence} ≥ threshold ${effectiveThreshold} → ${regime} regime`
      : `Confidence ${compositeConfidence.toFixed(1)} below threshold ${effectiveThreshold}${isSingleNode ? ' (single-node)' : ''}`,
  };

  logger.info('Consensus complete', {
    symbol:              bundle.symbol,
    compositeConfidence,
    approved,
    regime,
    nodesUsed:           availableNodes.join(', '),
    threshold:           effectiveThreshold,
  });

  return result;
}

module.exports = { runConsensus };
