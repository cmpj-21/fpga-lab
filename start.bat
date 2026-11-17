@echo off
setlocal
cd /d "%~dp0"
set OPEN_BROWSER=1
set APP_MODE=1
echo Starting Trace FPGA workbench...
node server.mjs
if errorlevel 1 pause
