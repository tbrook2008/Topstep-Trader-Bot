require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const alpacaClient = require('./execution/alpacaClient');
const vwapReversion = require('./quantitative/vwapReversion');
const fs = require('fs');
const path = require('path');

const SYMBOLS = ['MNQ', 'MES', 'MYM', 'M2K', 'MCL', 'MGC'];
const LIMIT = 5000;

const sdMultipliers = [1.5, 2.0, 2.5];
const rsiOversoldThresholds = [30, 35, 40];
const rsiOverboughtThresholds = [60, 65, 70];
const stopLossMultipliers = [1.0, 1.5, 2.0];

const topstepClient = require('./execution/topstepxClient');
const axios = require('axios');

async function fetchHistoricalData(symbol) {
  if (!topstepClient.jwtToken) {
    await topstepClient.authenticate();
  }
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

async function runOptimization() {
  const bestParams = {};

  for (const symbol of SYMBOLS) {
    console.log(`Fetching data for ${symbol}...`);
    const data = await fetchHistoricalData(symbol);
    if (data.length < 500) {
      console.log(`Not enough data for ${symbol}. Skipping.`);
      continue;
    }

    let bestWinRate = -1;
    let bestPnL = -999999;
    let bestConfig = null;

    for (const sd of sdMultipliers) {
      for (const rsiOS of rsiOversoldThresholds) {
        for (const rsiOB of rsiOverboughtThresholds) {
          for (const sl of stopLossMultipliers) {
            
            global.OPTIMIZE_PARAMS = {
              sdMultiplier: sd,
              rsiOversold: rsiOS,
              rsiOverbought: rsiOB,
              stopLossMultiplier: sl,
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
                let cTime = bar.timestamp || bar.time;
                if (typeof cTime === 'string') cTime = new Date(cTime).getTime();
                else if (typeof cTime === 'number' && cTime < 10000000000) cTime *= 1000;
                
                const now = new Date(cTime || Date.now());
                const nyTimeStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
                const nyTime = new Date(nyTimeStr);
                const timeVal = nyTime.getHours() * 100 + nyTime.getMinutes();
                
                if ((timeVal >= 945 && timeVal <= 1130) || (timeVal >= 1330 && timeVal <= 1530)) {
                  openPosition = {
                    direction: signal.action,
                    entryPrice: signal.entry,
                    stopLoss: signal.stopLoss,
                    takeProfit: signal.target
                  };
                }
              }
            }

            const winRate = trades > 0 ? (wins / trades) * 100 : 0;
            
            // Prioritize winRate primarily, but break ties with PnL. Requires >0 trades.
            if (trades > 0 && totalPnL > 0) {
              if (winRate > bestWinRate || (winRate === bestWinRate && totalPnL > bestPnL)) {
                bestWinRate = winRate;
                bestPnL = totalPnL;
                bestConfig = { sdMultiplier: sd, rsiOversold: rsiOS, rsiOverbought: rsiOB, stopLossMultiplier: sl, minVolumeRatio: 1.2 };
              }
            }
          }
        }
      }
    }

    if (bestConfig) {
      console.log(`Best for ${symbol}: ${JSON.stringify(bestConfig)} (WR: ${bestWinRate.toFixed(2)}%, PnL: $${bestPnL.toFixed(2)}, Trades: >0)`);
      bestParams[symbol] = bestConfig;
    } else {
      console.log(`No profitable configuration found for ${symbol}, keeping defaults.`);
    }
  }

  const outPath = path.join(__dirname, 'data/symbolParams.json');
  fs.writeFileSync(outPath, JSON.stringify(bestParams, null, 2));
  console.log(`Wrote best params to ${outPath}`);
}

runOptimization().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
