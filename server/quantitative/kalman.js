/**
 * server/quantitative/kalman.js
 * Dynamic State-Space Model using a 1D Kalman Filter.
 * Estimates the "true" underlying price and its velocity (trend) by filtering out market noise.
 */
const fs = require('fs');
const path = require('path');
let symbolParamsCache = null;
function getSymbolParams(symbol) {
  if (global.OPTIMIZE_PARAMS) return global.OPTIMIZE_PARAMS;
  if (!symbolParamsCache) {
    try {
      const p = path.join(__dirname, '../data/symbolParams.json');
      if (fs.existsSync(p)) symbolParamsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      else symbolParamsCache = {};
    } catch (e) { symbolParamsCache = {}; }
  }
  return symbolParamsCache[symbol] || {};
}

class KalmanFilter {
  constructor(R = 0.01, Q_pos = 0.0001, Q_vel = 0.0001) {
    this.R = R; // Measurement noise covariance
    // Process noise covariance matrix Q
    this.Q = [
      [Q_pos, 0],
      [0, Q_vel]
    ];
    
    // State estimate: [price, velocity]
    this.x = [0, 0];
    
    // Estimate covariance matrix P
    this.P = [
      [1, 0],
      [0, 1]
    ];
    
    this.initialized = false;
  }

  update(measurement) {
    if (!this.initialized) {
      this.x = [measurement, 0];
      this.initialized = true;
      return this.x;
    }

    // --- Predict Step ---
    // x_predict = F * x
    // F = [[1, 1], [0, 1]] (since dt = 1)
    const x_pred = [
      this.x[0] + this.x[1],
      this.x[1]
    ];

    // P_predict = F * P * F^T + Q
    const P_pred = [
      [this.P[0][0] + this.P[0][1] + this.P[1][0] + this.P[1][1] + this.Q[0][0], this.P[0][1] + this.P[1][1]],
      [this.P[1][0] + this.P[1][1], this.P[1][1] + this.Q[1][1]]
    ];

    // --- Update Step ---
    // Innovation y = z - H * x_pred (where H = [1, 0])
    const y = measurement - x_pred[0];

    // Innovation covariance S = H * P_pred * H^T + R = P_pred[0][0] + R
    const S = P_pred[0][0] + this.R;

    // Kalman Gain K = P_pred * H^T * S^-1
    const K = [
      P_pred[0][0] / S,
      P_pred[1][0] / S
    ];

    // Updated State Estimate x = x_pred + K * y
    this.x = [
      x_pred[0] + K[0] * y,
      x_pred[1] + K[1] * y
    ];

    // Updated Estimate Covariance P = (I - K * H) * P_pred
    this.P = [
      [(1 - K[0]) * P_pred[0][0], (1 - K[0]) * P_pred[0][1]],
      [-K[1] * P_pred[0][0] + P_pred[1][0], -K[1] * P_pred[0][1] + P_pred[1][1]]
    ];

    return this.x;
  }
}

/**
 * Evaluates the market momentum using the Kalman Filter.
 * @param {Array} history - OHLCV bars
 * @returns {string} 'LONG' | 'SHORT' | 'NO_TRADE'
 */
function evaluate(history, symbol) {
  if (!history || history.length < 50) return 'NO_TRADE';

  const params = getSymbolParams(symbol);
  const kalmanThreshold = params.kalmanThreshold || 2.0;

  // We tune R based on recent volatility to make the filter adaptive
  const closes = history.map(b => b.close);
  const recentCloses = closes.slice(-50);
  const mean = recentCloses.reduce((a, b) => a + b, 0) / 50;
  const variance = recentCloses.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 50;
  
  // Initialize Kalman Filter with adaptive measurement noise
  const kf = new KalmanFilter(variance * 0.1, variance * 0.001, variance * 0.0001);
  
  const velocities = [];
  const prices = [];
  
  for (let i = 0; i < closes.length; i++) {
    const [filteredPrice, velocity] = kf.update(closes[i]);
    prices.push(filteredPrice);
    velocities.push(velocity);
  }

  const last = velocities.length - 1;
  const currentVelocity = velocities[last];
  const prevVelocity = velocities[last - 1];
  
  // Calculate average velocity magnitude for dynamic thresholding
  const avgVelMag = velocities.slice(-20).reduce((a, b) => a + Math.abs(b), 0) / 20;

  // Signal generation based on velocity acceleration and magnitude
  if (currentVelocity > prevVelocity && currentVelocity > avgVelMag * kalmanThreshold) {
    // Confirm with volume
    const volumes = history.map(b => b.volume);
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const minVol = params.minVolumeRatio || 1.2;
    if (volumes[last] > avgVol * minVol) {
      return 'LONG';
    }
  }

  if (currentVelocity < prevVelocity && currentVelocity < -avgVelMag * kalmanThreshold) {
    const volumes = history.map(b => b.volume);
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const minVol = params.minVolumeRatio || 1.2;
    if (volumes[last] > avgVol * minVol) {
      return 'SHORT';
    }
  }

  return 'NO_TRADE';
}

module.exports = { evaluate, KalmanFilter };
