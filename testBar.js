const alpacaClient = require('./server/execution/alpacaClient');
const client = alpacaClient.getClient();
const stream = client.crypto_stream_v1beta3;
stream.onConnect(() => {
  stream.subscribeForBars(['BTC/USD']);
});
stream.onCryptoBar(bar => {
  console.log('BAR KEYS:', Object.keys(bar));
  console.log('BAR:', bar);
  process.exit(0);
});
stream.connect();
