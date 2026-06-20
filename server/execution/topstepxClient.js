const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

class TopstepXClient {
    constructor() {
        this.baseUrl = process.env.TOPSTEPX_API_URL || 'https://api.topstepx.com';
        this.username = process.env.TOPSTEPX_USERNAME;
        this.apiKey = process.env.TOPSTEPX_API_KEY;
        this.jwtToken = null;
    }

    /**
     * Authenticate with TopstepX using Username and API Key
     * Retrieves a JWT Token for subsequent requests.
     */
    async authenticate() {
        try {
            console.log(`[TopstepX] Authenticating as ${this.username}...`);
            // Note: The exact endpoint path might vary based on ProjectX documentation
            // Commonly it is /auth/login or /api/auth/token
            const response = await axios.post(`${this.baseUrl}/auth/login`, {
                username: this.username,
                apiKey: this.apiKey
            });

            if (response.data && response.data.token) {
                this.jwtToken = response.data.token;
                console.log('[TopstepX] Authentication successful! JWT Token acquired.');
                return true;
            } else {
                console.error('[TopstepX] Failed to acquire token from response.', response.data);
                return false;
            }
        } catch (error) {
            console.error('[TopstepX] Authentication error:', error.message);
            return false;
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
     * Required to ensure we are not breaching the $1,000 Daily Loss Limit.
     */
    async getAccountBalance() {
        if (!this.jwtToken) await this.authenticate();
        
        try {
            const response = await axios.get(`${this.baseUrl}/account/balance`, {
                headers: this._getAuthHeaders()
            });
            return response.data;
        } catch (error) {
            console.error('[TopstepX] Error fetching balance:', error.message);
            return null;
        }
    }

    /**
     * Place a Market Order for Futures
     * e.g., NQ, ES
     */
    async placeMarketOrder(symbol, side, quantity) {
        if (!this.jwtToken) await this.authenticate();

        try {
            console.log(`[TopstepX] Placing ${side} order for ${quantity} of ${symbol}...`);
            const response = await axios.post(`${this.baseUrl}/orders`, {
                symbol: symbol,
                orderType: 'Market',
                side: side, // 'Buy' or 'Sell'
                quantity: quantity
            }, {
                headers: this._getAuthHeaders()
            });
            
            console.log('[TopstepX] Order successfully placed:', response.data.orderId);
            return response.data;
        } catch (error) {
            console.error('[TopstepX] Error placing order:', error.message);
            return null;
        }
    }

    /**
     * Close all open positions (Flatten)
     * Used for the 3:00 PM auto-flatten rule.
     */
    async flattenAllPositions() {
        if (!this.jwtToken) await this.authenticate();

        try {
            console.log('[TopstepX] FLATTTENING ALL POSITIONS (End of Day / 3:00 PM CT)');
            // Endpoint depends on ProjectX docs, sometimes /positions/flatten
            const response = await axios.post(`${this.baseUrl}/positions/flatten`, {}, {
                headers: this._getAuthHeaders()
            });
            return response.data;
        } catch (error) {
            console.error('[TopstepX] Error flattening positions:', error.message);
            return null;
        }
    }
}

module.exports = new TopstepXClient();
