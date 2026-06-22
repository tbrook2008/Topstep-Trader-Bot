const { aggregate, barsHistory } = require('../server/data/dataAggregator');

async function test() {
    console.log('Priming history for MNQ...');
    const bundle = await aggregate('MNQ', {
        close: 30665,
        open: 30665,
        high: 30665,
        low: 30665,
        volume: 1
    });
    console.log(`Bundle generated. History length: ${bundle.history.length}`);
    console.log(`Last bar in history:`, bundle.history[bundle.history.length - 1]);
}
test();
