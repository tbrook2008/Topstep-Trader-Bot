const axios = require('axios');
const dotenv = require('dotenv');

const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

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
                return response.data.accounts[0];
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
                live: false // Adjust to true if trading live, but we use false to search broad matches usually
            }, {
                headers: this._getAuthHeaders()
            });

            if (response.data && response.data.contracts && response.data.contracts.length > 0) {
                // Find exact or closest match. The API returns an array of contracts.
                const contractId = response.data.contracts[0].id;
                this.contractCache[symbol] = contractId;
                return contractId;
            }
            throw new Error('Contract not found');
        } catch (error) {
            console.error(`[TopstepX] Error resolving contract ID for ${symbol}:`, error.message);
            return null;
        }
    }

    /**
     * Place a Market Order for Futures
     * e.g., NQ, ES
     */
    async placeMarketOrder(symbol, side, quantity) {
        if (!this.jwtToken || !this.accountId) await this.authenticate();

        try {
            const contractId = await this.getContractId(symbol);
            if (!contractId) throw new Error('Invalid contract ID');

            console.log(`[TopstepX] Placing ${side} order for ${quantity} of ${symbol} (Contract ID: ${contractId})...`);
            
            const sideInt = side.toLowerCase() === 'buy' ? 0 : 1;
            
            const response = await axios.post(`${this.baseUrl}/Order/place`, {
                accountId: this.accountId,
                contractId: contractId,
                type: 2, // 2 = Market Order
                side: sideInt, // 0 = Buy, 1 = Sell
                size: quantity
            }, {
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
                    const csvLine = `\n${timestamp},${symbol},${side},${quantity},${orderId}`;
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
    async flattenAllPositions(symbols = ['NQ', 'ES', 'CL', 'GC']) {
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
     * Close a specific open position
     */
    async closePosition(symbol) {
        if (!this.jwtToken || !this.accountId) await this.authenticate();
        try {
            const contractId = await this.getContractId(symbol);
            if (!contractId) throw new Error('Invalid contract ID');
            
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
                return { closed: false, reason: 'TopstepX API returned unsuccessful close' };
            }
        } catch (error) {
            console.error('[TopstepX] Error closing position:', error.message);
            return { closed: false, reason: error.message };
        }
    }
}

module.exports = new TopstepXClient();
