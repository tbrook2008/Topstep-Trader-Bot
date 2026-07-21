const topstepxClient = require('./topstepxClient');

async function liquidateAll() {
    console.log('Initiating emergency liquidation on TopstepX...');
    await topstepxClient.authenticate();
    
    // First let's check for any working orders and cancel them for the standard symbols
    const symbols = ['MNQ', 'MES', 'MYM', 'M2K', 'MGC', 'MCL', 'ZB'];
    for (const symbol of symbols) {
        await topstepxClient.cancelAllWorkingOrdersForSymbol(symbol);
    }
    
    // Then try to flatten everything
    const results = await topstepxClient.flattenAllPositions(symbols);
    console.log('Flatten results:', results);
    process.exit(0);
}

liquidateAll();
