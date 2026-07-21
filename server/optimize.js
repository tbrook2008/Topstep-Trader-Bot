require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Mock dependencies to avoid real API calls & DB writes
const topstepClient = require('./execution/topstepxClient');
const validator = require('./risk/validator');
const tradeLogger = require('./db/tradeLogger');
const memory = require('./db/strategyMemory');
const schema = require('./db/schema');
const logger = require('./utils/logger');

// Silence the logger to prevent console flood during grid search
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

topstepClient.getAccountBalance = async () => ({ currentBalance: 50000, canTrade: true });
topstepClient.placeMarketOrder = async (tsSymbol, side, qty, tpTicks, slTicks, price) => ({ orderId: 'mock-' + Date.now() });
topstepClient.flattenAllPositions = async () => ({ success: true });
validator.runChecks = async () => ({ passed: true });
tradeLogger.logTrade = () => 'mock-trade-id';
memory.saveSetup = () => {};
const notifier = require('./utils/notifier');
notifier.sendSMS = () => {};
schema.setState = () => {};

process.env.DRY_RUN = 'false';

const tradeExecutor = require('./execution/tradeExecutor');

const SYMBOLS = ['MNQ', 'MES', 'MYM', 'M2K', 'MCL', 'MGC'];
const HISTORY_LIMIT = 500;
const DAYS_TO_FETCH = 7; // Rigorous backtesting

// Grid search parameter combinations for VWAP
const minVolumeRatios = [1.0, 1.2];
const sdMultipliers = [2.0, 2.5];
const rsiOversolds = [35];
const rsiOverboughts = [65];
const stopLossMultipliers = [1.5, 2.0];
const takeProfitMultipliers = [0.8, 1.0];

const combinations = [];
for (const v of minVolumeRatios) {
  for (const sd of sdMultipliers) {
    for (const rsio of rsiOversolds) {
      for (const rsib of rsiOverboughts) {
        for (const sl of stopLossMultipliers) {
          for (const tp of takeProfitMultipliers) {
            combinations.push({
              minVolumeRatio: v,
              sdMultiplier: sd,
              rsiOversold: rsio,
              rsiOverbought: rsib,
              stopLossMultiplier: sl,
              takeProfitMultiplier: tp
            });
          }
        }
      }
    }
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const axios = require('axios');

async function fetchHistoricalData(symbol, days) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  const now = new Date();
  
  let bars = [];
  try {
    const contractId = await topstepClient.getContractId(symbol);
    if (!contractId) return [];

    const payload = {
        contractId: contractId,
        live: false,
        startTime: start.toISOString(),
        endTime: now.toISOString(),
        unit: 2, // Minute
        unitNumber: 1,
        limit: 1500 * days // Roughly 1500 min per day
    };

    const response = await axios.post(`${topstepClient.baseUrl}/History/retrieveBars`, payload, {
        headers: topstepClient._getAuthHeaders()
    });

    if (response.data && response.data.success && response.data.bars) {
      bars = response.data.bars.reverse().map(b => ({
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        timestamp: b.t
      }));
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

      // Session time filter (EST)
      const date = new Date(bar.timestamp);
      const nyTimeStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const nyTime = new Date(nyTimeStr);
      if (nyTime.getHours() === 16) {
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
    
    // Prioritize maximum absolute PnL to get funded ASAP, requiring at least a 50% win rate.
    // The previous 70% hard lock caused it to over-filter trades.
    const isTargetHit = winRate >= 0.65 && totalPnL > 0;
    const currentBestHit = bestWinRate >= 0.65 && maxPnL > 0;

    if (trades > 0) {
      if (isTargetHit) {
        if (!currentBestHit || totalPnL > maxPnL) {
          bestWinRate = winRate;
          maxPnL = totalPnL;
          bestParams = params;
        }
      } else if (!currentBestHit) {
        // Fallback: ALWAYS track the best PnL and win rate, even if not hitting target, so we at least use the best possible parameters instead of falling back to default.
        // Or if both have < 0 PnL, pick the one with better PnL (less loss).
        if (bestParams === null || totalPnL > maxPnL || (totalPnL === maxPnL && winRate > bestWinRate)) {
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
