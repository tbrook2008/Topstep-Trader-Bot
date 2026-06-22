const yahooFinance = require('yahoo-finance2').default;

async function test() {
    try {
        console.log('Fetching ES=F (E-Mini S&P 500)...');
        const es = await yahooFinance.quote('ES=F');
        console.log(`ES=F Price: ${es.regularMarketPrice}, Time: ${new Date(es.regularMarketTime).toISOString()}`);

        console.log('Fetching NQ=F (E-Mini Nasdaq 100)...');
        const nq = await yahooFinance.quote('NQ=F');
        console.log(`NQ=F Price: ${nq.regularMarketPrice}, Time: ${new Date(nq.regularMarketTime).toISOString()}`);

        console.log('Fetching historical 1m bars for ES=F...');
        const queryOptions = { period1: new Date(Date.now() - 60 * 60 * 1000), interval: '1m' };
        const result = await yahooFinance.chart('ES=F', queryOptions);
        if (result && result.quotes && result.quotes.length > 0) {
            const latestBar = result.quotes[result.quotes.length - 1];
            console.log('Latest 1m Bar:', latestBar);
        } else {
            console.log('No historical bars returned.');
        }
    } catch (err) {
        console.error('Error fetching from Yahoo Finance:', err.message);
    }
}
test();
