require('dotenv').config();
const { analyze, refine } = require('./server/ai/ollamaNode');
const logger = require('./server/utils/logger');

async function run() {
  const bundle = {
    symbol: 'TEST/USD',
    headlines: [
      { title: 'Test company faces massive bankruptcy rumors' },
      { title: 'CEO sells all shares, steps down' }
    ]
  };

  console.log('--- Original Analyze ---');
  const original = await analyze(bundle);
  console.log('Original Result:', original);

  console.log('\n--- Debate Refinement ---');
  const geminiResult = {
    score: 80,
    direction: 'LONG',
    thesis: 'Despite the news, the charts show a massive bullish divergence. RSI is oversold at 15, MACD has crossed over, and heavy whale accumulation is visible on the order books. This is a classic bear trap.'
  };

  const refined = await refine(bundle, original, geminiResult);
  console.log('Refined Result:', refined);
}

run().catch(console.error);
