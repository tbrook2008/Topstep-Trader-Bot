const topstepx = require('../server/execution/topstepxClient');

async function testOrder() {
    await topstepx.authenticate();
    
    // Attempt placing a market order for M2K with autoOCO: true or something
    try {
        const symbol = 'M2K';
        const side = 'BUY';
        const quantity = 1;
        const tpTicks = 20; // 20 ticks = 2 points
        const slTicks = 10; // 10 ticks = 1 point
        
        const contractId = await topstepx.getContractId(symbol);
        
        const requestBody = {
            accountId: topstepx.accountId,
            contractId: contractId,
            type: 2, // Market
            side: 0, // Buy
            size: quantity,
            isAutoOco: true, // Let's guess this?
            autoOCO: true, // Let's guess this too?
            takeProfitBracket: { ticks: tpTicks, type: 1 },
            stopLossBracket: { ticks: -slTicks, type: 4 } // Neg for longing
        };
        
        const axios = require('axios');
        const response = await axios.post(`${topstepx.baseUrl}/Order/place`, requestBody, {
            headers: topstepx._getAuthHeaders()
        });
        console.log("Success!", response.data);
    } catch (e) {
        console.error("Failed:", e.response ? e.response.data : e.message);
    }
}

testOrder();
