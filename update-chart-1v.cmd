@echo off
rem Paivittaa BTS/XBTSX.USDT TradingView-chartin 1 vuoden datalla (~30-60s).
rem Kaytto: kaksoisklikkaa tama tiedosto.
cd /d "%~dp0"
node update-chart.mjs 12
pause
