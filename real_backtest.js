require('dotenv').config();
const hmm = require('./server/quantitative/hmm');
const kalman = require('./server/quantitative/kalman');
const ouModel = require('./server/quantitative/ouModel');
const atr = require('./server/quantitative/atr');
const alpacaClient = require('./server/execution/alpacaClient');

const ATR_MULTIPLIER = 3.5;
const ATR_TARGET_MULTIPLIER = 2.0;

async function fetchRealData(symbol, days = 7) {
  const client = alpacaClient.getClient();
  const start = new Date();
  start.setDate(start.getDate() - days);
  
  console.log(`Fetching real historical data for ${symbol}...`);
  let bars = [];
  
  try {
    if (symbol.includes('/')) {
      const resp = await client.getCryptoBars([symbol], {
        timeframe: '1Min',
        start: start.toISOString(),
        limit: 10000
      });
      bars = resp.get(symbol) || [];
      return bars.map(b => ({
        time: new Date(b.Timestamp).getTime(),
        open: b.Open, high: b.High, low: b.Low, close: b.Close, volume: b.Volume
      }));
    } else {
      const iter = client.getBarsV2(symbol, {
        timeframe: '1Min',
        start: start.toISOString(),
        limit: 10000
      });
      for await (const b of iter) {
        bars.push({
          time: new Date(b.Timestamp).getTime(),
          open: b.OpenPrice, high: b.HighPrice, low: b.LowPrice, close: b.ClosePrice, volume: b.Volume
        });
      }
      return bars;
    }
  } catch (err) {
    console.error("Failed to fetch data:", err.message);
    return [];
  }
}

async function runBacktest(symbol) {
  const data = await fetchRealData(symbol, 7);
  if (data.length < 1500) {
    console.log(`Not enough data for ${symbol}. Need at least 1500 bars, got ${data.length}`);
    return;
  }
  
  console.log(`Running backtest on ${data.length} real 1-minute bars for ${symbol}...`);
  
  let position = null;
  const trades = [];
  
  let wins = 0;
  let losses = 0;
  let totalProfit = 0; 
  
  for (let i = 60; i < data.length; i++) {
    const currentBar = data[i];
    
    if (position) {
      let closed = false;
      let pnlPct = 0;
      
      if (position.type === 'LONG') {
        const trailingStop = currentBar.high - (position.atrAtEntry * ATR_MULTIPLIER);
        if (trailingStop > position.stopLoss) position.stopLoss = trailingStop;

        if (currentBar.low <= position.stopLoss) {
          pnlPct = (position.stopLoss - position.entryPrice) / position.entryPrice;
          closed = true;
        } else if (currentBar.high >= position.takeProfit) {
          pnlPct = (position.takeProfit - position.entryPrice) / position.entryPrice;
          closed = true;
        }
      } else if (position.type === 'SHORT') {
        const trailingStop = currentBar.low + (position.atrAtEntry * ATR_MULTIPLIER);
        if (trailingStop < position.stopLoss) position.stopLoss = trailingStop;

        if (currentBar.high >= position.stopLoss) {
          pnlPct = (position.entryPrice - position.stopLoss) / position.entryPrice;
          closed = true;
        } else if (currentBar.low <= position.takeProfit) {
          pnlPct = (position.entryPrice - position.takeProfit) / position.entryPrice;
          closed = true;
        }
      }
      
      if (closed) {
        if (pnlPct > 0) wins++;
        else losses++;
        totalProfit += pnlPct;
        
        trades.push({
          type: position.type,
          entry: position.entryPrice,
          exit: pnlPct > 0 ? position.takeProfit : position.stopLoss,
          pnlPct: pnlPct * 100,
          strategy: position.strategy,
          barsHeld: i - position.entryIndex
        });
        
        position = null;
      }
      continue;
    }
    
    const history = data.slice(Math.max(0, i - 1500), i + 1);
    
    const regime = hmm.classifyRegime(history.slice(-100));
    const isTrending = regime === 'momentum';
    
    let signal = 'NO_TRADE';
    let strategy = '';
    
    if (isTrending) {
      signal = kalman.evaluate(history.slice(-100));
      if (signal !== 'NO_TRADE') strategy = 'KalmanFilter';
    } else {
      signal = ouModel.evaluate(history.slice(-100));
      if (signal !== 'NO_TRADE') strategy = 'OrnsteinUhlenbeck';
    }
    
    if (signal !== 'NO_TRADE') {
      const currentAtr = atr.calculateATR(history, 14);
      if (!currentAtr) continue;
      
      const entryPrice = currentBar.close;
      const stopDistance = currentAtr * ATR_MULTIPLIER;
      const targetDistance = stopDistance * ATR_TARGET_MULTIPLIER;
      
      position = {
        type: signal,
        entryPrice: entryPrice,
        entryIndex: i,
        strategy: strategy,
        atrAtEntry: currentAtr,
        stopLoss: signal === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance,
        takeProfit: signal === 'LONG' ? entryPrice + targetDistance : entryPrice - targetDistance
      };
    }
  }
  
  console.log(`\n--- REAL DATA BACKTEST RESULTS: ${symbol} ---`);
  console.log(`Total Trades: ${trades.length}`);
  if (trades.length > 0) {
    console.log(`Wins: ${wins} | Losses: ${losses}`);
    console.log(`Win Rate: ${((wins / trades.length) * 100).toFixed(2)}%`);
    console.log(`Total Net Profit: ${(totalProfit * 100).toFixed(2)}%`);
  }
}

async function run() {
  const symbols = process.argv.slice(2);
  if (symbols.length === 0) {
    symbols.push('BTC/USD', 'SPY');
  }
  for (const sym of symbols) {
    await runBacktest(sym);
  }
}

run();
