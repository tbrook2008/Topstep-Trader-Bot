@echo off
:: ============================================================
::  AI TRADER — Background Launcher
::  Double-click start-trader.vbs to run this silently
:: ============================================================

cd /d "c:\Users\tbroo\Desktop\AI TRADER\AI-Trader"

:: ── Step 1: Ensure Ollama is running ────────────────────────
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL 2>&1
if ERRORLEVEL 1 (
    start "" /B ollama serve
    timeout /t 6 /nobreak >NUL
)

:: ── Step 2: Kill any stale PM2 daemon & start fresh ─────────
call pm2 kill >NUL 2>&1
timeout /t 2 /nobreak >NUL

:: ── Step 3: Resurrect saved processes from dump file ────────
call pm2 resurrect >NUL 2>&1
timeout /t 2 /nobreak >NUL

:: ── Step 4: If resurrect found nothing, start manually ──────
call pm2 list | find "ai-trader-api" >NUL 2>&1
if ERRORLEVEL 1 (
    call pm2 start server/index.js --name ai-trader-api >NUL 2>&1
    call pm2 start server/autonomous/scheduler.js --name ai-trader-loop >NUL 2>&1
    call pm2 save >NUL 2>&1
)

exit
