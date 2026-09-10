@echo off
rem Paivittaa BTS/XBTSX.USDT TradingView-chartin 2 vuoden datalla (~1-2 min).
rem Koko historia (2021 saakka, ~20 min): kayta update-chart.cmd
cd /d "%~dp0"
node update-chart.mjs 24
pause
