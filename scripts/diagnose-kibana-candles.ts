#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

'use strict';

/**
 * Diagnostic: Fetch raw Kibana LP candles for pool 1.19.133
 * to verify whether the pool actually had trading activity.
 */

const kibanaSource = require('../market_adapter/inputs/kibana_source');

async function main() {
    const assetA = { id: '1.3.5537', precision: 4, symbol: 'IOB.XRP' };
    const assetB = { id: '1.3.0', precision: 5, symbol: 'BTS' };

    console.log('Fetching Kibana LP candles for pool 1.19.133...');
    console.log('Lookback: 720h (30 days), interval: 1h');
    console.log('');

    const candles = await kibanaSource.getLpCandlesForPool('1.19.133', assetA, assetB, {
        intervalSeconds: 3600,
        lookbackHours: 720,
        consolidateByTimestamp: true,
        apiKey: null,
    });

    console.log(`Total candles returned: ${candles.length}`);

    if (candles.length === 0) {
        console.log('NO candles returned from Kibana.');
        return;
    }

    // Count unique close prices
    const uniqueCloses = new Set(candles.map((c: any) => c[4]));
    console.log(`Unique close prices: ${uniqueCloses.size}`);

    // Show first and last
    const first = candles[0];
    const last = candles[candles.length - 1];
    console.log(`\nFirst candle: ${new Date(first[0]).toISOString()} O=${first[1]} H=${first[2]} L=${first[3]} C=${first[4]} vol=${first[5]}`);
    console.log(`Last candle:  ${new Date(last[0]).toISOString()} O=${last[1]} H=${last[2]} L=${last[3]} C=${last[4]} vol=${last[5]}`);

    // Find runs of identical prices
    let maxRun = 0;
    let currentRun = 1;
    let maxRunPrice = null;
    for (let i = 1; i < candles.length; i++) {
        if (candles[i][4] === candles[i - 1][4]) {
            currentRun++;
            if (currentRun > maxRun) {
                maxRun = currentRun;
                maxRunPrice = candles[i][4];
            }
        } else {
            currentRun = 1;
        }
    }
    console.log(`\nLongest run of identical closes: ${maxRun} candles @ ${maxRunPrice}`);

    // Show candles with non-zero volume
    const withVolume = candles.filter((c: any) => c[5] > 0);
    console.log(`Candles with volume > 0: ${withVolume.length}`);

    const trueOhlc = candles.filter((c: any) => c[5] > 0 && (c[1] !== c[2] || c[1] !== c[3] || c[1] !== c[4]));
    console.log(`Candles with non-flat OHLC: ${trueOhlc.length}`);

    // Show a few recent candles
    console.log('\nLast 10 candles:');
    candles.slice(-10).forEach((c: any, i: any) => {
        const idx = candles.length - 10 + i;
        console.log(`  [${idx}] ${new Date(c[0]).toISOString()} O=${c[1].toFixed(6)} H=${c[2].toFixed(6)} L=${c[3].toFixed(6)} C=${c[4].toFixed(6)} vol=${c[5].toFixed(2)}`);
    });

    if (trueOhlc.length > 0) {
        console.log('\nRecent non-flat OHLC candles:');
        trueOhlc.slice(-10).forEach((c: any) => {
            console.log(`  ${new Date(c[0]).toISOString()} O=${c[1].toFixed(6)} H=${c[2].toFixed(6)} L=${c[3].toFixed(6)} C=${c[4].toFixed(6)} vol=${c[5].toFixed(2)}`);
        });
    }

    // Show where price changes happened
    console.log('\nPrice changes (first 20):');
    let changes = 0;
    for (let i = 1; i < candles.length && changes < 20; i++) {
        if (candles[i][4] !== candles[i - 1][4]) {
            changes++;
            console.log(`  [${i}] ${new Date(candles[i][0]).toISOString()} ${candles[i - 1][4].toFixed(6)} -> ${candles[i][4].toFixed(6)}`);
        }
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
export {};
