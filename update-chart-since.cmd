@echo off
rem Paivittaa BTS/XBTSX.USDT TradingView-chartin datalla 11.8.2024 lahtien tasta paivasta.
rem Muokkaa aloituspæivææ alta: vaihda --alku paivamaaran perassa oleva arvo (VVVV-KK-PP).
cd /d "%~dp0"
node update-chart.mjs --since 2024-08-11
pause
