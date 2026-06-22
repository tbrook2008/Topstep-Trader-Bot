require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const topstepClient = require('../server/execution/topstepxClient');
const vwapReversion = require('../server/quantitative/vwapReversion');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SYMBOLS = ['MNQ', 'MES', 'MCL', 'MGC'];
const LIMIT = 5000; // Fetch max possible bars

async function fetchHistoricalData(symbol) {
  await topstepClient.authenticate();
  const contractId = await topstepClient.getContractId(symbol);
  if (!contractId) return [];
  
  const now = new Date();
  const past = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
  
  const payload = {
    contractId: contractId,
    live: false,
    startTime: past.toISOString(),
    endTime: now.toISOString(),
    unit: 2, // Minute
    unitNumber: 1,
    limit: LIMIT
  };
  
  try {
    const response = await axios.post(`${topstepClient.baseUrl}/History/retrieveBars`, payload, {
      headers: topstepClient._getAuthHeaders()
    });
    
    if (response.data && response.data.success && response.data.bars) {
      // Reverse so oldest is first
      return response.data.bars.reverse().map(b => ({
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        timestamp: b.t,
        symbol: symbol
      }));
    }
  } catch (err) {
    console.error(`Error fetching data for ${symbol}:`, err.message);
  }
  return [];
}

async function runBacktest() {
  console.log('--- TOPSTEPX BACKTEST REPORT ---');
  
  // Load optimized params
  let symbolParams = {};
  try {
    symbolParams = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/data/symbolParams.json')));
  } catch (e) {
    console.log('No optimized params found, using defaults.');
  }

  let totalGrandPnL = 0;
  let totalGrandTrades = 0;
  let totalGrandWins = 0;

  for (const symbol of SYMBOLS) {
    console.log(`\nFetching historical data for ${symbol}...`);
    const data = await fetchHistoricalData(symbol);
    console.log(`Received ${data.length} candles for ${symbol}.`);
    if (data.length < 200) {
      console.log(`Not enough data for ${symbol}. Skipping.`);
      continue;
    }

    // Set global params for the VWAP module based on symbolParams
    global.OPTIMIZE_PARAMS = symbolParams[symbol] || {
      sdMultiplier: 2.0,
      rsiOversold: 35,
      rsiOverbought: 65,
      stopLossMultiplier: 1.5,
      minVolumeRatio: 1.2
    };

    let openPosition = null;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    let totalPnL = 0;

    const HISTORY_LIMIT = 200;
    let history = [];

    for (let i = 0; i < data.length; i++) {
      const bar = data[i];
      history.push(bar);
      if (history.length > HISTORY_LIMIT) history.shift();
      if (history.length < HISTORY_LIMIT) continue;

      if (openPosition) {
        if (openPosition.direction === 'LONG') {
          if (bar.low <= openPosition.stopLoss) {
            losses++; trades++; totalPnL -= (openPosition.entryPrice - openPosition.stopLoss);
            openPosition = null;
          } else if (bar.high >= openPosition.takeProfit) {
            wins++; trades++; totalPnL += (openPosition.takeProfit - openPosition.entryPrice);
            openPosition = null;
          }
        } else if (openPosition.direction === 'SHORT') {
          if (bar.high >= openPosition.stopLoss) {
            losses++; trades++; totalPnL -= (openPosition.stopLoss - openPosition.entryPrice);
            openPosition = null;
          } else if (bar.low <= openPosition.takeProfit) {
            wins++; trades++; totalPnL += (openPosition.entryPrice - openPosition.takeProfit);
            openPosition = null;
          }
        }
        continue;
      }

      const signal = vwapReversion.evaluate(history);
      if (signal) {
        openPosition = {
          direction: signal.action,
          entryPrice: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.target
        };
      }
    }

    const winRate = trades > 0 ? (wins / trades) * 100 : 0;
    console.log(`=================================`);
    console.log(`Results for ${symbol}:`);
    console.log(`Trades Taken: ${trades}`);
    console.log(`Win Rate: ${winRate.toFixed(2)}% (${wins}W / ${losses}L)`);
    console.log(`Estimated PnL (Points): ${totalPnL.toFixed(2)}`);
    
    // For MNQ ($2/point), MES ($5/point), MCL ($10/point), MGC ($10/point) approx.
    let multiplier = 2;
    if (symbol === 'MES') multiplier = 5;
    if (symbol === 'MCL') multiplier = 10;
    if (symbol === 'MGC') multiplier = 10;
    const dollarPnL = totalPnL * multiplier;
    console.log(`Estimated PnL (Dollars/1 contract): $${dollarPnL.toFixed(2)}`);
    console.log(`=================================`);

    totalGrandPnL += dollarPnL;
    totalGrandTrades += trades;
    totalGrandWins += wins;
  }
  
  const grandWinRate = totalGrandTrades > 0 ? (totalGrandWins / totalGrandTrades) * 100 : 0;
  console.log(`\n=== PORTFOLIO TOTALS ===`);
  console.log(`Total Trades: ${totalGrandTrades}`);
  console.log(`Overall Win Rate: ${grandWinRate.toFixed(2)}%`);
  console.log(`Total Estimated PnL: $${totalGrandPnL.toFixed(2)}`);
}

runBacktest().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
