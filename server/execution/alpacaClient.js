/**
 * server/execution/alpacaClient.js
 * Alpaca SDK v3 wrapper — paper & live trading.
 * v3 uses named exports from '@alpacahq/alpaca-trade-api'.
 */
require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const logger = require('../utils/logger');

let _client = null;

function getClient() {
  if (!_client) {
    const isLive = (process.env.TRADING_MODE || 'paper') === 'live';
    _client = new Alpaca({
      keyId:     process.env.ALPACA_API_KEY,
      secretKey: process.env.ALPACA_SECRET_KEY,
      paper:     !isLive,
    });
    logger.info('Alpaca client initialized', { mode: isLive ? 'LIVE' : 'PAPER' });
  }
  return _client;
}

/**
 * Fetch the live Alpaca account — use portfolio_value for Kelly sizing.
 */
async function getAccount() {
  const account = await getClient().getAccount();
  return {
    portfolioValue:   parseFloat(account.portfolio_value),
    buyingPower:      parseFloat(account.buying_power),
    cash:             parseFloat(account.cash),
    equity:           parseFloat(account.equity),
    daytradeCount:    parseInt(account.daytrade_count || 0),
    patternDayTrader: account.pattern_day_trader,
    tradingBlocked:   account.trading_blocked,
    status:           account.status,
  };
}

/**
 * Fetch all open positions.
 */
async function getOpenPositions() {
  const positions = await getClient().getPositions();
  return positions.map(p => ({
    symbol:      p.symbol,
    qty:         parseFloat(p.qty),
    side:        p.side,
    marketValue: parseFloat(p.market_value),
    avgEntry:    parseFloat(p.avg_entry_price),
    unrealizedPL: parseFloat(p.unrealized_pl),
    unrealizedPLPct: parseFloat(p.unrealized_plpc),
    currentPrice: parseFloat(p.current_price),
  }));
}

/**
 * Close a specific open position (market order).
 */
async function closePosition(symbol) {
  // Alpaca expects 'BTCUSD' for closing positions, not 'BTC/USD'
  const alpacaSymbol = symbol.replace(/[-/]/g, '').toUpperCase();
  logger.info('Closing position', { symbol: alpacaSymbol });
  try {
    // Alpaca returns 403 if there are open working orders (like TP/SL brackets) for the position.
    // We must fetch and cancel them first.
    // Note: getOrders uses 'BTC/USD' but positions return 'BTCUSD', so we fetch all and filter locally.
    const allOpenOrders = await getClient().getOrders({ status: 'open' });
    const matchingOrders = allOpenOrders.filter(o => o.symbol.replace(/[-/]/g, '').toUpperCase() === alpacaSymbol);
    
    for (const order of matchingOrders) {
      logger.info('Canceling open order before closing position', { orderId: order.id });
      await getClient().cancelOrder(order.id);
    }
    // Give Alpaca a brief moment to process the cancellations
    if (matchingOrders.length > 0) {
      await new Promise(r => setTimeout(r, 1000));
    }

    await getClient().closePosition(alpacaSymbol);
    logger.info('Position closed', { symbol: alpacaSymbol });
    return { closed: true };
  } catch (err) {
    logger.error('Failed to close position', { symbol: alpacaSymbol, error: err.message });
    return { closed: false, reason: err.message };
  }
}

/**
 * Submit a bracket order (entry + stop-loss + take-profit in one atomic order).
 * Alpaca paper trading fully supports bracket orders.
 */
async function submitOrder({ symbol, qty, side, stopPrice, takeProfitPrice, trailPrice }) {
  const alpacaSymbol = normalizeSymbol(symbol);
  const isCrypto     = isCryptoSymbol(symbol);

  const orderParams = {
    symbol:        alpacaSymbol,
    side:          side.toLowerCase(),   // 'buy' or 'sell'
    type:          'market',
    time_in_force: isCrypto ? 'gtc' : 'day', // Crypto requires GTC
  };

  // If Alpaca paper trading allows fractional shares for market orders, we can just use qty.toString()
  // Since we aren't using bracket orders anymore, fractional shares are perfectly valid.
  orderParams.qty = qty.toString();

  if (trailPrice) {
    orderParams.order_class = 'oto';
    orderParams.stop_loss = { trail_price: isCrypto ? trailPrice.toFixed(4) : trailPrice.toFixed(2) };
  } else if (stopPrice || takeProfitPrice) {
    orderParams.order_class = 'bracket';
    if (stopPrice) {
      orderParams.stop_loss = { stop_price: isCrypto ? stopPrice.toFixed(4) : stopPrice.toFixed(2) };
    }
    if (takeProfitPrice) {
      orderParams.take_profit = { limit_price: isCrypto ? takeProfitPrice.toFixed(4) : takeProfitPrice.toFixed(2) };
    }
  }

  logger.info(`Submitting ${orderParams.order_class || 'market'} order to Alpaca: ${alpacaSymbol} | Qty: ${orderParams.qty} | Side: ${orderParams.side}`);
  logger.info(`Exact orderParams: ${JSON.stringify(orderParams)}`);

  const order = await getClient().createOrder(orderParams);

  return {
    orderId:   order.id,
    clientId:  order.client_order_id,
    symbol:    order.symbol,
    qty:       order.qty,
    side:      order.side,
    type:      order.type,
    status:    order.status,
    createdAt: order.created_at,
  };
}

async function getOrderStatus(orderId) {
  const order = await getClient().getOrder(orderId);
  return {
    status:    order.status,
    filledAt:  order.filled_at,
    filledQty: order.filled_qty,
    avgPrice:  order.filled_avg_price,
  };
}

async function cancelOrder(orderId) {
  return getClient().cancelOrder(orderId);
}

/**
 * Normalize symbol for Alpaca (BTC-USD → BTC/USD for crypto).
 */
function normalizeSymbol(symbol) {
  if (isCryptoSymbol(symbol)) {
    // Alpaca v3 crypto uses BTC/USD format
    const base = symbol.split(/[-/]/)[0].toUpperCase();
    return `${base}/USD`;
  }
  return symbol.toUpperCase();
}

function isCryptoSymbol(symbol) {
  return symbol.includes('/') || symbol.endsWith('USD');
}

module.exports = {
  getClient,
  getAccount,
  getOpenPositions,
  closePosition,
  submitOrder,
  getOrderStatus,
  cancelOrder,
};
