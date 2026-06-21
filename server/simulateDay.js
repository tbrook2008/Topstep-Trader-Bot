require('dotenv').config();
const killSwitch = require('./risk/killSwitch');
const { runChecks } = require('./risk/validator');

async function simulateTradingDay() {
  console.log("=== TOPSTEP COMBINE COMPLIANCE SIMULATION ===\n");
  
  // Mock data
  const symbol = "NQ";
  const positionDollars = 5000;
  
  let simulatedTime = new Date('2023-10-10T08:00:00-04:00'); // 8:00 AM ET (7:00 AM CT)
  const endTime = new Date('2023-10-10T16:15:00-04:00');   // 4:15 PM ET (3:15 PM CT)
  
  let openPositions = [];
  
  console.log(`[08:00 ET] Simulation Started.`);
  
  while (simulatedTime <= endTime) {
    const timeStr = simulatedTime.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true });
    const hoursET = simulatedTime.getHours();
    const minutes = simulatedTime.getMinutes();
    
    // Simulate Cron Jobs from index.js
    // Red Folder: 8:28 - 8:32 AM ET
    if (hoursET === 8 && minutes === 28) {
      console.log(`\n[${timeStr}] CRON: Red Folder News Block (8:30 AM ET) ACTIVATED`);
      killSwitch.activate('Red Folder News Block (8:30 AM ET)');
    }
    if (hoursET === 8 && minutes === 32) {
      console.log(`[${timeStr}] CRON: Red Folder News Block DEACTIVATED`);
      killSwitch.deactivate();
    }
    
    // Red Folder: 1:58 - 2:02 PM ET (13:58 - 14:02 ET)
    if (hoursET === 13 && minutes === 58) {
      console.log(`\n[${timeStr}] CRON: Red Folder News Block (2:00 PM ET) ACTIVATED`);
      killSwitch.activate('Red Folder News Block (2:00 PM ET)');
    }
    if (hoursET === 14 && minutes === 2) {
      console.log(`[${timeStr}] CRON: Red Folder News Block DEACTIVATED`);
      killSwitch.deactivate();
    }
    
    // EOD Flatten: 2:58 PM CT = 3:58 PM ET (15:58 ET)
    if (hoursET === 15 && minutes === 58) {
      console.log(`\n[${timeStr}] CRON: EOD Guardrail REACHED. Flattening all positions!`);
      openPositions = []; // Flatten
      killSwitch.activate('EOD Liquidated (Topstep Compliance)');
      console.log(`[${timeStr}] Positions flattened. Kill-switch engaged until next session.`);
    }

    // --- Simulating Trade Attempts ---
    
    // Attempt trade at 8:30 AM ET (During news)
    if (hoursET === 8 && minutes === 30) {
      console.log(`\n[${timeStr}] Strategy generated a BUY signal for ${symbol}...`);
      const check = await runChecks({
        consensus: { approved: true, direction: 'LONG' },
        symbol,
        positionDollars,
        openPositions
      });
      console.log(`-> Trade passed? ${check.passed}. Failed checks: ${check.failed.join(', ')}`);
    }

    // Attempt trade at 10:00 AM ET (Safe time, but let's test scaling)
    if (hoursET === 10 && minutes === 0) {
      console.log(`\n[${timeStr}] Market moving fast! Strategy generated 5 simultaneous signals...`);
      // Add 4 positions to simulate currently holding 4
      openPositions = [{ symbol: 'ES' }, { symbol: 'RTY' }, { symbol: 'YM' }, { symbol: 'GC' }];
      console.log(`-> Currently holding ${openPositions.length} positions.`);
      
      const check = await runChecks({
        consensus: { approved: true, direction: 'LONG' },
        symbol: 'NQ',
        positionDollars,
        openPositions
      });
      console.log(`-> 5th Trade passed? ${check.passed}. Failed checks: ${check.failed.join(', ')}`);
    }

    // Attempt trade at 11:00 AM ET (Safe time, normal trade)
    if (hoursET === 11 && minutes === 0) {
      console.log(`\n[${timeStr}] Market stabilized. Holding 1 position.`);
      openPositions = [{ symbol: 'ES' }];
      const check = await runChecks({
        consensus: { approved: true, direction: 'LONG' },
        symbol: 'NQ',
        positionDollars,
        openPositions
      });
      console.log(`-> Trade passed? ${check.passed}. (Clean entry)`);
      if (check.passed) {
        openPositions.push({ symbol: 'NQ' });
      }
    }

    // Attempt trade at 4:05 PM ET (After EOD Liquidate)
    if (hoursET === 16 && minutes === 5) {
      console.log(`\n[${timeStr}] Late afternoon signal generated for ${symbol}...`);
      const check = await runChecks({
        consensus: { approved: true, direction: 'LONG' },
        symbol,
        positionDollars,
        openPositions
      });
      console.log(`-> Trade passed? ${check.passed}. Failed checks: ${check.failed.join(', ')}`);
    }

    // Advance 1 minute
    simulatedTime.setMinutes(simulatedTime.getMinutes() + 1);
  }
  
  console.log("\n[16:15 ET] Simulation Complete.");
}

simulateTradingDay().catch(console.error);
