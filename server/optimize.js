require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Mock dependencies to avoid real API calls & DB writes
const alpacaClient = require('./execution/alpacaClient');
const kelly = require('./risk/kellyCriterion');
const validator = require('./risk/validator');
const tradeLogger = require('./db/tradeLogger');
const memory = require('./db/strategyMemory');
const schema = require('./db/schema');
const logger = require('./utils/logger');

// Silence the logger to prevent console flood during grid search
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

alpacaClient.getAccount = async () => ({ portfolioValue: 100000, buyingPower: 100000, tradingBlocked: false });
alpacaClient.getOpenPositions = async () => ([]);
alpacaClient.submitOrder = async (opts) => ({ orderId: 'mock-' + Date.now(), ...opts });
validator.runChecks = async () => ({ passed: true });
tradeLogger.logTrade = () => 'mock-trade-id';
memory.saveSetup = () => {};
schema.setState = () => {};

process.env.DRY_RUN = 'false';

const tradeExecutor = require('./execution/tradeExecutor');

const SYMBOLS = process.env.WATCHED_SYMBOLS ? process.env.WATCHED_SYMBOLS.split(',').map(s=>s.trim()) : ['AAPL', 'BTC/USD'];
const HISTORY_LIMIT = 200;
const DAYS_TO_FETCH = 2; // Test on last 48 hours for fast optimization

// Grid search parameter combinations (reduced search space)
const minVolumeRatios = [2.0, 2.5];
const zScoreThresholds = [2.0, 2.8];
const kalmanThresholds = [3.0, 5.0, 7.0];
const trendPeriods = [50];
const dynamicRR_Trendings = [1.5, 2.0];
const dynamicRR_MeanRevs = [1.0, 1.5];

const combinations = [];
for (const v of minVolumeRatios) {
  for (const z of zScoreThresholds) {
    for (const k of kalmanThresholds) {
      for (const t of trendPeriods) {
        for (const rt of dynamicRR_Trendings) {
          for (const rm of dynamicRR_MeanRevs) {
            combinations.push({
              minVolumeRatio: v,
              zScoreThreshold: z,
              kalmanThreshold: k,
              trendPeriod: t,
              dynamicRR_Trending: rt,
              dynamicRR_MeanRev: rm
            });
          }
        }
      }
    }
  }
}


async function fetchHistoricalData(symbol, days) {
  const client = alpacaClient.getClient();
  const start = new Date();
  start.setDate(start.getDate() - days);
  
  let bars = [];
  try {
    const isCrypto = symbol.includes('/') || symbol.endsWith('USD');
    if (isCrypto) {
      const resp = await client.getCryptoBars([symbol], {
        timeframe: '1Min',
        start: start.toISOString(),
        limit: 10000
      });
      bars = resp.get(symbol) || [];
      bars = bars.map(b => ({
        open: b.Open, high: b.High, low: b.Low, close: b.Close, volume: b.Volume, timestamp: b.Timestamp
      }));
    } else {
      const iter = client.getBarsV2(symbol, {
        timeframe: '1Min',
        start: start.toISOString(),
      });
      for await (const b of iter) {
        bars.push({
          open: b.OpenPrice, high: b.HighPrice, low: b.LowPrice, close: b.ClosePrice, volume: b.Volume, timestamp: b.Timestamp
        });
      }
    }
    return bars;
  } catch (err) {
    console.error(`Error fetching data for ${symbol}:`, err.message);
    return [];
  }
}

async function optimizeSymbol(symbol, data) {
  let bestWinRate = -1;
  let maxPnL = -Infinity;
  let bestParams = null;

  console.log(`Optimizing ${symbol} with ${combinations.length} combinations...`);

  for (const params of combinations) {
    global.OPTIMIZE_PARAMS = params;

    let history = [];
    let openPosition = null;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    let totalPnL = 0;

    for (let i = 0; i < data.length; i++) {
      const bar = data[i];
      history.push(bar);
      
      if (history.length > HISTORY_LIMIT) {
        history.shift();
      }

      if (history.length < HISTORY_LIMIT) continue;

      if (openPosition) {
        if (openPosition.direction === 'LONG') {
          if (bar.low <= openPosition.stopLoss) {
            losses++; trades++;
            totalPnL -= (openPosition.entryPrice - openPosition.stopLoss) * openPosition.qty;
            openPosition = null;
          } else if (bar.high >= openPosition.takeProfit) {
            wins++; trades++;
            totalPnL += (openPosition.takeProfit - openPosition.entryPrice) * openPosition.qty;
            openPosition = null;
          }
        } else if (openPosition.direction === 'SHORT') {
          if (bar.high >= openPosition.stopLoss) {
            losses++; trades++;
            totalPnL -= (openPosition.stopLoss - openPosition.entryPrice) * openPosition.qty;
            openPosition = null;
          } else if (bar.low <= openPosition.takeProfit) {
            wins++; trades++;
            totalPnL += (openPosition.entryPrice - openPosition.takeProfit) * openPosition.qty;
            openPosition = null;
          }
        }
        continue;
      }

      const bundle = { symbol, price: bar.close, history: [...history] };
      const result = await tradeExecutor.execute({ bundle });
      
      if (result && result.executed) {
        openPosition = {
          direction: result.direction,
          entryPrice: result.entryPrice,
          stopLoss: result.direction === 'LONG' ? result.entryPrice - result.trailPrice : result.entryPrice + result.trailPrice,
          takeProfit: result.targetPrice,
          qty: result.qty || 1,
          timestamp: bar.timestamp
        };
      }
    }

    const winRate = trades > 0 ? (wins / trades) : 0;
    
    // We want >= 70% win rate and maximum PnL.
    const isTargetHit = winRate >= 0.70 && totalPnL > 0;
    const currentBestHit = bestWinRate >= 0.70 && maxPnL > 0;

    if (trades > 0) {
      if (isTargetHit) {
        if (!currentBestHit || totalPnL > maxPnL) {
          bestWinRate = winRate;
          maxPnL = totalPnL;
          bestParams = params;
        }
      } else if (!currentBestHit) {
        // Fallback: Try to find highest winRate, tie-break with PnL
        if (winRate > bestWinRate || (winRate === bestWinRate && totalPnL > maxPnL)) {
          bestWinRate = winRate;
          maxPnL = totalPnL;
          bestParams = params;
        }
      }
    }
  }

  // Clear global override after optimization
  global.OPTIMIZE_PARAMS = null;
  return { bestParams, bestWinRate, maxPnL };
}

async function runOptimization() {
  console.log(`Starting optimization for symbols: ${SYMBOLS.join(', ')}\n`);
  const finalParams = {};

  for (const symbol of SYMBOLS) {
    console.log(`Fetching data for ${symbol}...`);
    const data = await fetchHistoricalData(symbol, DAYS_TO_FETCH);
    console.log(`Fetched ${data.length} bars for ${symbol}.`);
    
    if (data.length < HISTORY_LIMIT) {
      console.log(`Not enough data for ${symbol}. Skipping.\n`);
      continue;
    }

    const { bestParams, bestWinRate, maxPnL } = await optimizeSymbol(symbol, data);
    if (bestParams) {
      console.log(`Best for ${symbol} -> WinRate: ${(bestWinRate * 100).toFixed(2)}%, PnL: $${maxPnL.toFixed(4)}`);
      console.log(bestParams);
      finalParams[symbol] = bestParams;
    } else {
      console.log(`No valid trades found for ${symbol} across any combination.`);
    }
  }

  const dirPath = path.join(__dirname, 'data');
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  const filePath = path.join(dirPath, 'symbolParams.json');
  fs.writeFileSync(filePath, JSON.stringify(finalParams, null, 2));
  console.log(`Saved optimized parameters to ${filePath}`);
}

if (require.main === module) {
  runOptimization().then(() => {
    console.log("Optimization completed.");
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
