@echo off
rem Paivittaa BTS/XBTSX.USDT TradingView-chartin KOKO poolin historialla (2021 saakka, ~3-5 min).
rem Lyhyempi historia: muokkaa alla olevaa argumenttia (esim. 24 = 2 vuotta).
cd /d "%~dp0"
node update-chart.mjs kaikki
pause
