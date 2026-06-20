const hmm = require('./server/quantitative/hmm');
const kalman = require('./server/quantitative/kalman');
const ouModel = require('./server/quantitative/ouModel');
const atr = require('./server/quantitative/atr');

const ATR_MULTIPLIER = 3.5;
const ATR_TARGET_MULTIPLIER = 2.0;

// Generate realistic 1-minute crypto data (random walk with volatility)
function generateSyntheticData(numBars, startPrice) {
  const data = [];
  let currentPrice = startPrice;
  const volatility = 0.001; // 0.1% volatility per minute

  for (let i = 0; i < numBars; i++) {
    const move = currentPrice * volatility * (Math.random() - 0.5) * 2;
    const open = currentPrice;
    const close = currentPrice + move;
    const high = Math.max(open, close) + (currentPrice * volatility * Math.random());
    const low = Math.min(open, close) - (currentPrice * volatility * Math.random());
    
    data.push({
      time: Date.now() + (i * 60000),
      open, high, low, close,
      volume: Math.random() * 100 + 10 // Random volume
    });
    
    currentPrice = close;
  }
  return data;
}

async function runBacktest() {
  console.log("Generating 10,000 minutes of synthetic market data (~7 days)...");
  const data = generateSyntheticData(10000, 60000); // Start BTC at $60k
  
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
        // Trailing Stop Logic for LONG
        const trailingStop = currentBar.high - (position.atrAtEntry * ATR_MULTIPLIER);
        if (trailingStop > position.stopLoss) {
          position.stopLoss = trailingStop; // Ratchet stop up
        }

        if (currentBar.low <= position.stopLoss) {
          pnlPct = (position.stopLoss - position.entryPrice) / position.entryPrice;
          closed = true;
        } else if (currentBar.high >= position.takeProfit) {
          pnlPct = (position.takeProfit - position.entryPrice) / position.entryPrice;
          closed = true;
        }
      } else if (position.type === 'SHORT') {
        // Trailing Stop Logic for SHORT
        const trailingStop = currentBar.low + (position.atrAtEntry * ATR_MULTIPLIER);
        if (trailingStop < position.stopLoss) {
          position.stopLoss = trailingStop; // Ratchet stop down
        }

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
    
    const history = data.slice(Math.max(0, i - 1500), i); // VWAP needs 1440 bars
    
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
  
  console.log('\n--- SYNTHETIC BACKTEST RESULTS ---');
  console.log(`Total Trades: ${trades.length}`);
  if (trades.length > 0) {
    console.log(`Wins: ${wins} | Losses: ${losses}`);
    console.log(`Win Rate: ${((wins / trades.length) * 100).toFixed(2)}%`);
    console.log(`Total Net Profit: ${(totalProfit * 100).toFixed(2)}% (Unleveraged cumulative)`);
    
    const kalmanTrades = trades.filter(t => t.strategy === 'KalmanFilter');
    const ouTrades = trades.filter(t => t.strategy === 'OrnsteinUhlenbeck');
    
    if (kalmanTrades.length > 0) {
      const kWins = kalmanTrades.filter(t => t.pnlPct > 0).length;
      console.log(`Kalman Filter Trades: ${kalmanTrades.length} (Win Rate: ${((kWins/kalmanTrades.length)*100).toFixed(2)}%)`);
    }
    if (ouTrades.length > 0) {
      const ouWins = ouTrades.filter(t => t.pnlPct > 0).length;
      console.log(`Ornstein-Uhlenbeck Trades: ${ouTrades.length} (Win Rate: ${((ouWins/ouTrades.length)*100).toFixed(2)}%)`);
    }
  } else {
    console.log("No trades executed.");
  }
}

runBacktest();
