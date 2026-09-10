@echo off
rem Paivittaa BTS/XBTSX.USDT TradingView-chartin 3 kuukauden datalla (kevyt versio ~2200 kynttilaa).
rem Tarkoitettu zoomailuun: 4x vahemman dataa kuin 1v-versio, ei kaadu GPU-muistiin.
rem Kaytto: kaksoisklikkaa tama tiedosto.
cd /d "%~dp0"
node update-chart.mjs 3
pause
