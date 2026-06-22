const topstepClient = require('./server/execution/topstepxClient.js');

async function test() {
    console.log("Testing TopstepX Authentication...");
    const authSuccess = await topstepClient.authenticate();
    console.log("Auth Success:", authSuccess);

    if (authSuccess) {
        console.log("\nTesting Contract Resolution for NQ...");
        const contractId = await topstepClient.getContractId('NQ');
        console.log("Resolved Contract ID for NQ:", contractId);
        
        console.log("\nFetching Account Balance...");
        const balance = await topstepClient.getAccountBalance();
        console.log("Account Balance Data:", balance);
    }
}
test();
