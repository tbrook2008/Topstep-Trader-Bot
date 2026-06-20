/**
 * test-full-cycle.js
 * End-to-end integration test: runs the full data→AI→quant→validate pipeline
 * against a real Alpaca paper account (no actual orders placed, DRY_RUN=true)
 */
require('dotenv').config();
process.env.DRY_RUN = 'true'; // Never place real orders in this test

const { aggregate } = require('./server/data/dataAggregator');
const { runConsensus } = require('./server/ai/consensus');
const { execute } = require('./server/execution/tradeExecutor');
const { logDecision } = require('./server/db/tradeLogger');
const { initDb } = require('./server/db/schema');

async function main() {
  initDb();
  const symbol = 'BTC/USD';
  console.log(`\nTesting full system for ${symbol}...`);

  // 1. Data aggregation
  const fakeBar = { open: 80000, high: 80500, low: 79500, close: 80200, volume: 5000 };
  const bundle = await aggregate(symbol, fakeBar);
  console.log(`[✅] Data aggregated | price=$${bundle.price} | bars=${bundle.history.length} | headlines=${bundle.headlines.length}`);

  // 2. AI Consensus
  const consensus = await runConsensus(bundle);
  console.log(`[✅] Consensus | regime=${consensus.regime} | score=${consensus.compositeScore} | approved=${consensus.approved}`);

  // 3. Log decision
  const decisionId = logDecision({
    symbol,
    geminiThesis:    consensus.nodeResults?.gemini?.thesis,
    ollamaSentiment: consensus.nodeResults?.ollama?.sentiment,
    compositeScore:  consensus.compositeScore,
    approved:        consensus.approved,
    direction:       consensus.regime,
    reason:          consensus.reason,
    nodesUsed:       consensus.nodesUsed,
  });
  console.log(`[✅] Decision logged | id=${decisionId}`);

  // 4. Execute (DRY_RUN=true, no real order)
  const result = await execute({ bundle, consensus, decisionId });
  console.log(`[✅] Execute result | executed=${result.executed} | reason=${result.reason || 'approved'}`);

  console.log('\nTest complete!');
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
