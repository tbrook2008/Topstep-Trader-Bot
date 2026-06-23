const topstep = require('../execution/topstepxClient');

(async () => {
    try {
        await topstep.authenticate();
        const response = await require('axios').post(`${topstep.baseUrl}/Order/search`, {
            accountId: topstep.accountId,
            startTimestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
            endTimestamp: new Date().toISOString()
        }, {
            headers: topstep._getAuthHeaders()
        });

        if (response.data && response.data.orders) {
            const orders = response.data.orders;
            // Get all filled orders (status 5) or partial filled (status 3) or working but with fillVolume > 0
            const executed = orders.filter(o => o.fillVolume > 0);
            
            console.log(`Found ${executed.length} orders with fills.`);
            // Sort by time
            executed.sort((a, b) => new Date(a.creationTimestamp) - new Date(b.creationTimestamp));
            
            for (let o of executed) {
                console.log(`${o.creationTimestamp} | ${o.symbolId} | ${o.side === 0 ? 'BUY' : 'SELL'} | Vol: ${o.fillVolume} | Price: ${o.filledPrice} | Type: ${o.type} | ID: ${o.id}`);
            }
        }
    } catch (e) {
        console.error("Error:", e.message, e.response?.data);
    }
})();
