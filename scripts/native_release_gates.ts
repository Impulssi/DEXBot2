#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PATHS } from '../modules/paths.js';
import { Config } from '../modules/config.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../modules/utils/errors';
const nodeBin = process.execPath;

function run(label: any, args: any, env: any = {}) {
    console.log(`\n=== ${label} ===`);
    const result = spawnSync(nodeBin, args, {
        cwd: PATHS.PROJECT_ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function assertMainnetCorpusReport() {
    const reportPath = Config.NATIVE_MAINNET_CORPUS_REPORT
        || path.join(PATHS.PROFILES.NATIVE_VALIDATION_DIR, 'mainnet_corpus_report.json');

    if (!fs.existsSync(reportPath)) {
        console.error('\nMissing mainnet corpus validation report.');
        console.error(`Expected: ${reportPath}`);
        console.error('Generate a report proving 50+ real mainnet transactions serialize byte-for-byte with native serialization before release.');
        process.exit(1);
    }

    let report;
    try {
        report = readJSON(reportPath);
    } catch (err: any) {
        console.error(`\nInvalid mainnet corpus report JSON: ${getErrorMessage(err)}`);
        process.exit(1);
    }

    const txCount = Number(report.transactionCount || report.transactions || 0);
    if (report.passed !== true || txCount < 50) {
        console.error('\nMainnet corpus report did not satisfy release requirements.');
        console.error('Required: passed=true and transactionCount>=50');
        console.error(`Actual: passed=${report.passed}, transactionCount=${txCount}`);
        process.exit(1);
    }

    console.log(`\nMainnet corpus report accepted: ${txCount} transaction(s).`);
}

run('Native serializer snapshots', ['--import', 'tsx', 'tests/test_native_serial_ops.ts']);

run('Native ECC invariants', ['--import', 'tsx', 'tests/test_native_ecc.ts']);

assertMainnetCorpusReport();

console.log('\nNative release gates passed.');
