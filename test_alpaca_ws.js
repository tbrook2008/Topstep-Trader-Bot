require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
});
const stream = alpaca.data_stream_v2;
stream.onConnect(() => {
  console.log('Connected to Alpaca Stock WS');
  stream.subscribeForBars(['SPY']);
});
stream.onError(err => console.error('WS Error:', err));
stream.onStockBar(bar => console.log('Bar:', bar.Symbol, bar.ClosePrice));
stream.connect();
