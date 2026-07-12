const axios = require('axios');
const https = require('https');
const dotenv = require('dotenv');

const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Setup axios to use keepAlive to prevent continuous DNS lookups that cause ENOTFOUND
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, family: 4 });

class TopstepXClient {
    constructor() {
        // ProjectX Gateway API uses api.topstepx.com/api
        this.baseUrl = process.env.TOPSTEPX_API_URL || 'https://api.topstepx.com/api';
        this.username = process.env.TOPSTEPX_USERNAME;
        this.apiKey = process.env.TOPSTEPX_API_KEY;
        this.jwtToken = null;
        this.accountId = null;
        this.contractCache = {}; // Cache contract IDs by symbol
    }

    /**
     * Authenticate with ProjectX Gateway API using Username and API Key
     * Retrieves a JWT Token for subsequent requests, and fetches the active account ID.
     */
    async authenticate() {
        try {
            console.log(`[TopstepX] Authenticating as ${this.username}...`);
            const response = await axios.post(`${this.baseUrl}/Auth/loginKey`, {
                userName: this.username,
                apiKey: this.apiKey
            });

            if (response.data && response.data.token) {
                this.jwtToken = response.data.token;
                console.log('[TopstepX] Authentication successful! JWT Token acquired.');
                
                // Now fetch the active account ID
                await this._fetchAccountId();
                return true;
            } else {
                console.error('[TopstepX] Failed to acquire token:', response.data);
                return false;
            }
        } catch (error) {
            console.error('[TopstepX] Authentication error:', error.response ? error.response.data : error.message);
            return false;
        }
    }

    async _fetchAccountId() {
        try {
            const response = await axios.post(`${this.baseUrl}/Account/search`, {
                onlyActiveAccounts: true
            }, {
                headers: this._getAuthHeaders()
            });
            if (response.data && response.data.accounts && response.data.accounts.length > 0) {
                this.accountId = response.data.accounts[0].id;
                console.log(`[TopstepX] Active Account ID set to: ${this.accountId}`);
            }
        } catch (error) {
            console.error('[TopstepX] Error fetching account ID:', error.message);
        }
    }

    /**
     * Helper method to build headers for authenticated requests
     */
    _getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.jwtToken}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Fetch Account Balance / Risk Details
     * Required to ensure we are not breaching the Daily Loss Limit.
     */
    async getAccountBalance() {
        if (!this.jwtToken || !this.accountId) await this.authenticate();
        
        try {
            const response = await axios.post(`${this.baseUrl}/Account/search`, {
                onlyActiveAccounts: true
            }, {
                headers: this._getAuthHeaders()
            });
            
            if (response.data && response.data.accounts && response.data.accounts.length > 0) {
                const account = response.data.accounts[0];
                account.balance = account.currentBalance || account.accountBalance || account.balance || 50000;
                return account;
            }
            return null;
        } catch (error) {
            console.error('[TopstepX] Error fetching balance:', error.message);
            return null;
        }
    }

    /**
     * Resolve symbol to contract ID
     */
    async getContractId(symbol) {
        if (this.contractCache[symbol]) return this.contractCache[symbol];
        if (!this.jwtToken) await this.authenticate();

        try {
            const response = await axios.post(`${this.baseUrl}/Contract/search`, {
                searchText: symbol,
                live: process.env.TRADING_MODE === 'live'
            }, {
                headers: this._getAuthHeaders()
            });

            if (response.data && response.data.contracts && response.data.contracts.length > 0) {
                const contractId = response.data.contracts[0].id;
                this.contractCache[symbol] = contractId;
                return contractId;
            }
            throw new Error('Contract not found');
        } catch (error) {
            if (error.response && error.response.status === 401) {
                console.log(`[TopstepX] Token expired. Re-authenticating...`);
                this.jwtToken = null;
                await this.authenticate();
                return this.getContractId(symbol); // Retry
            }
            console.error(`[TopstepX] Error resolving contract ID for ${symbol}:`, error.message);
            return null;
        }
    }

    /**
     * Place a Market Order for Futures with optional bracket orders
     * e.g., MES, MNQ
     */
    async placeMarketOrder(symbol, side, quantity, tpTicks, slTicks, entryPrice = 'Market') {
        if (!this.jwtToken || !this.accountId) await this.authenticate();

        try {
            const contractId = await this.getContractId(symbol);
            if (!contractId) throw new Error('Invalid contract ID');

            console.log(`[TopstepX] Placing ${side} order for ${quantity} of ${symbol} (Contract ID: ${contractId}) TP Ticks: ${tpTicks} SL Ticks: ${slTicks}...`);
            
            const sideInt = side.toLowerCase() === 'buy' ? 0 : 1;
            
            const requestBody = {
                accountId: this.accountId,
                contractId: contractId,
                type: 2, // 2 = Market Order
                side: sideInt, // 0 = Buy, 1 = Sell
                size: quantity,
                isAutoOco: true // Required for Bracket Orders
            };

            // Bracket logic for TopstepX API (Offsets are relative to entry)
            // Buy (0): TP is positive, SL is negative
            // Sell (1): TP is negative, SL is positive
            if (tpTicks && tpTicks > 0) {
                const finalTpTicks = sideInt === 0 ? Math.round(tpTicks) : -Math.round(tpTicks);
                requestBody.takeProfitBracket = { ticks: finalTpTicks, type: 1 }; // 1 = Limit Order
            }
            if (slTicks && slTicks > 0) {
                const finalSlTicks = sideInt === 0 ? -Math.round(slTicks) : Math.round(slTicks);
                requestBody.stopLossBracket = { ticks: finalSlTicks, type: 4 }; // 4 = Stop Order
            }
            
            const response = await axios.post(`${this.baseUrl}/Order/place`, requestBody, {
                headers: this._getAuthHeaders()
            });
            
            if (response.data && response.data.success) {
                const orderId = response.data.orderId;
                console.log('[TopstepX] Order successfully placed:', orderId);
                
                // --- SPREADSHEET LOGGING ---
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const csvPath = path.join(__dirname, '..', 'data', 'trades.csv');
                    const timestamp = new Date().toISOString();
                    const csvLine = `\n${timestamp},${symbol},${side},${quantity},${orderId},${entryPrice}`;
                    fs.appendFileSync(csvPath, csvLine);
                    console.log(`[TopstepX] Trade successfully logged to spreadsheet.`);
                } catch (err) {
                    console.error('[TopstepX] Failed to log trade to CSV:', err.message);
                }
                // ---------------------------

                return response.data;
            } else {
                console.error('[TopstepX] Order failed:', response.data);
                return null;
            }
        } catch (error) {
            console.error('[TopstepX] Error placing order:', error.response ? error.response.data : error.message);
            return null;
        }
    }

    /**
     * Close all open positions (Flatten)
     * Used for the 3:00 PM auto-flatten rule.
     */
    async flattenAllPositions(symbols = ['MNQ', 'MES', 'MYM', 'M2K', 'MGC', 'MCL', 'ZB']) {
        if (!this.jwtToken || !this.accountId) await this.authenticate();

        try {
            console.log('[TopstepX] FLATTENING SPECIFIED POSITIONS...');
            const results = [];
            
            for (const symbol of symbols) {
                const contractId = await this.getContractId(symbol);
                if (!contractId) continue;
                
                try {
                    const response = await axios.post(`${this.baseUrl}/Position/closeContract`, {
                        accountId: this.accountId,
                        contractId: contractId
                    }, {
                        headers: this._getAuthHeaders()
                    });
                    
                    if (response.data && response.data.success) {
                        results.push(response.data);
                        console.log(`[TopstepX] Successfully flattened ${symbol}`);
                    }
                } catch (e) {
                    // Ignore errors if there was no position open to close
                }
            }
            
            return results;
        } catch (error) {
            console.error('[TopstepX] Error flattening positions:', error.message);
            return null;
        }
    }

    /**
     * Cancel all working orders for a specific symbol
     */
    async cancelAllWorkingOrdersForSymbol(symbol) {
        if (!this.jwtToken || !this.accountId) await this.authenticate();
        try {
            const contractId = await this.getContractId(symbol);
            if (!contractId) throw new Error('Invalid contract ID');

            console.log(`[TopstepX] Searching for working orders to cancel for ${symbol}...`);
            // Fetch working orders
            const response = await axios.post(`${this.baseUrl}/Order/search`, {
                accountId: this.accountId,
                // Some APIs ignore onlyWorking, so we provide timestamps to bound the search
                startTimestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                endTimestamp: new Date().toISOString()
            }, {
                headers: this._getAuthHeaders()
            });

            if (response.data && response.data.orders) {
                // Filter for working orders (status 1 = Pending, 2 = Working/Open, 3 = Partial)
                // We'll just cancel anything that isn't status 4 (Cancelled), 5 (Filled), 6 (Rejected)
                const workingOrders = response.data.orders.filter(o => 
                    o.contractId === contractId && o.status < 4
                );

                if (workingOrders.length > 0) {
                    console.log(`[TopstepX] Found ${workingOrders.length} working order(s) for ${symbol}. Cancelling...`);
                    for (const order of workingOrders) {
                        try {
                            await axios.post(`${this.baseUrl}/Order/cancel`, {
                                accountId: this.accountId,
                                orderId: order.id
                            }, {
                                headers: this._getAuthHeaders()
                            });
                            console.log(`[TopstepX] Cancelled order ${order.id}`);
                        } catch (err) {
                            console.error(`[TopstepX] Failed to cancel order ${order.id}:`, err.response ? err.response.data : err.message);
                        }
                    }
                    // Give Topstep a brief moment to process the cancellations
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            return true;
        } catch (error) {
            console.error(`[TopstepX] Error cancelling working orders for ${symbol}:`, error.message);
            return false;
        }
    }

    /**
     * Close a specific open position
     */
    async closePosition(symbol) {
        if (!this.jwtToken || !this.accountId) await this.authenticate();
        try {
            const contractId = await this.getContractId(symbol);
            if (!contractId) throw new Error('Invalid contract ID');
            
            // CRITICAL FIX: Cancel working brackets first so closeContract doesn't fail!
            await this.cancelAllWorkingOrdersForSymbol(symbol);

            console.log(`[TopstepX] Closing position for ${symbol}...`);
            const response = await axios.post(`${this.baseUrl}/Position/closeContract`, {
                accountId: this.accountId,
                contractId: contractId
            }, {
                headers: this._getAuthHeaders()
            });
            
            if (response.data && response.data.success) {
                return { closed: true };
            } else {
                console.error('[TopstepX] closeContract failed:', response.data);
                return { closed: false, reason: response.data.errorMessage || 'TopstepX API returned unsuccessful close' };
            }
        } catch (error) {
            console.error('[TopstepX] Error closing position:', error.message);
            return { closed: false, reason: error.message };
        }
    }

    /**
     * Fetch historical bars from TopstepX
     */
    async getLatestBars(symbols, count = 2) {
        if (!this.jwtToken) await this.authenticate();
        
        const now = new Date();
        const past = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
        
        const results = {};
        for (const symbol of symbols) {
            try {
                const contractId = await this.getContractId(symbol);
                if (!contractId) continue;
                
                const payload = {
                    contractId: contractId,
                    live: false,
                    startTime: past.toISOString(),
                    endTime: now.toISOString(),
                    unit: 2, // 2 = Minute
                    unitNumber: 1,
                    limit: count
                };
                
                const response = await axios.post(`${this.baseUrl}/History/retrieveBars`, payload, {
                    headers: this._getAuthHeaders()
                });
                
                if (response.data && response.data.success && response.data.bars && response.data.bars.length > 0) {
                    const latestBar = response.data.bars[0]; // First item is the most recent
                    results[symbol] = {
                        Timestamp: latestBar.t,
                        OpenPrice: latestBar.o,
                        HighPrice: latestBar.h,
                        LowPrice: latestBar.l,
                        ClosePrice: latestBar.c,
                        Volume: latestBar.v
                    };
                }
            } catch (err) {
                if (err.response && err.response.status === 401) {
                    console.log(`[TopstepX] Token expired during getLatestBars. Re-authenticating...`);
                    this.jwtToken = null;
                    await this.authenticate();
                    return this.getLatestBars(symbols, count);
                }
                console.error(`[TopstepX] Error fetching bars for ${symbol}:`, err.message);
            }
        }
        return results;
    }
}

module.exports = new TopstepXClient();
