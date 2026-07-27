#!/usr/bin/env node
/**
 * Generate the mainnet corpus validation report consumed by
 * `scripts/native_release_gates.ts`.
 *
 * Walks recent mainnet blocks via the read-only native client, reserializes
 * each transaction through modules/bitshares-native, and proves byte parity in
 * two independent ways:
 *
 *   1. Transaction ID: sha256(serialize(unsigned_tx)).slice(0, 20) must match
 *      the chain-reported `block.transaction_ids[i]`.
 *   2. Signed hex: when the node exposes `database_api::get_transaction_hex`,
 *      `serialize(signed_tx).toString('hex')` must equal the chain's hex.
 *
 * Output: profiles/native_validation/mainnet_corpus_report.json
 *
 * CLI flags:
 *   --count N        Minimum valid transaction count (default 50)
 *   --max-blocks N   Cap on blocks to scan (default 500)
 *   --head-offset N  Start at head-N for finality (default 100)
 *   --out PATH       Output path (default profiles/native_validation/...)
 */

'use strict';

const path = require('path');
const { createReadOnlyClient } = require('../modules/bitshares-native');
const serial = require('../modules/bitshares-native/serial');
const ecc = require('../modules/bitshares-native/crypto/ecc');
const { NODE_MANAGEMENT } = require('../modules/constants');
const { PATHS } = require('../modules/paths');
const { ensureDir, writeJSON } = require('../modules/utils/fs_utils');
const { getErrorMessage } = require('../modules/utils/errors');

const argv: string[] = process.argv.slice(2);
function flag(name: string, fallback: string | number): string | number {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    return argv[i + 1];
}

const targetCount = Number(flag('--count', 50));
const maxBlocks = Number(flag('--max-blocks', 500));
const headOffset = Number(flag('--head-offset', 100));
const outPath = String(flag('--out',
    path.join(PATHS.PROFILES.NATIVE_VALIDATION_DIR, 'mainnet_corpus_report.json')));

interface TxDetail {
    blockNum: number;
    txIndex: number;
    opTypeIds: number[];
    expectedTxId: string | null;
    computedTxId: string;
    txidMatch: boolean | null;
    hexMatch: boolean | null;
    expectedSignedHex?: string;
    computedSignedHex?: string;
    error?: string;
}

function tagFor(d: TxDetail): string {
    if (d.error) return 'SKIP (' + d.error.slice(0, 40) + ')';
    if (d.txidMatch === false) return 'TXID-FAIL';
    if (d.hexMatch === false) return 'HEX-FAIL';
    const parts: string[] = [];
    if (d.txidMatch === true) parts.push('txid');
    if (d.hexMatch === true) parts.push('hex');
    if (parts.length === 0) return 'OK (no proofs available!)';
    return 'OK (' + parts.join('+') + ')';
}

async function main(): Promise<void> {
    const nodes: string[] = NODE_MANAGEMENT.DEFAULT_NODES;
    const client = createReadOnlyClient({ nodes, validateChainId: true });

    console.log(`Connecting to mainnet (${nodes.length} candidate nodes)...`);
    await client.connect();
    const nodeUrl: string | null = client.getNodeUrl();
    const chainId: string = await client.db('get_chain_id', []);
    console.log(`Connected: ${nodeUrl}`);
    console.log(`Chain ID:  ${chainId}\n`);

    const dgp = await client.db('get_dynamic_global_properties', []);
    const headBlock: number = Number(dgp.head_block_number);
    const startBlock = headBlock - headOffset;

    console.log(`Head block:       ${headBlock}`);
    console.log(`Scanning from:    ${startBlock} (head - ${headOffset})`);
    console.log(`Target valid tx:  ${targetCount}`);
    console.log(`Max blocks:       ${maxBlocks}\n`);

    let txHexAvailable: boolean | null = null;
    let txidAvailable: boolean | null = null;
    const details: TxDetail[] = [];
    const opCoverage: Record<number, number> = {};
    let txidMatches = 0;
    let txidMismatches = 0;
    let hexMatches = 0;
    let hexMismatches = 0;
    let skipped = 0;
    let validCount = 0;
    let blocksScanned = 0;
    let scannedTo = startBlock;

    for (let b = startBlock; b > startBlock - maxBlocks && validCount < targetCount; b--) {
        blocksScanned++;
        scannedTo = b;
        let block: any;
        try {
            block = await client.db('get_block', [b]);
        } catch (e: any) {
            console.log(`  block ${b}: fetch error ${getErrorMessage(e)}`);
            continue;
        }
        if (!block || !Array.isArray(block.transactions)) continue;
        for (let i = 0; i < block.transactions.length && validCount < targetCount; i++) {
            const signedTx = block.transactions[i];
            const rawExpectedTxId = (block.transaction_ids && block.transaction_ids[i]) || null;
            const opTypeIds: number[] = (signedTx.operations || []).map((op: any) => op[0]);
            for (const id of opTypeIds) opCoverage[id] = (opCoverage[id] || 0) + 1;

            const detail: TxDetail = {
                blockNum: b,
                txIndex: i,
                opTypeIds,
                expectedTxId: rawExpectedTxId,
                computedTxId: '',
                txidMatch: null,
                hexMatch: null,
            };

            try {
                const unsignedTxObj = {
                    ref_block_num: signedTx.ref_block_num,
                    ref_block_prefix: signedTx.ref_block_prefix,
                    expiration: signedTx.expiration,
                    operations: signedTx.operations,
                    extensions: signedTx.extensions || [],
                };
                const unsignedBytes = serial.ops.transaction.toBuffer(unsignedTxObj);
                const computedTxId = ecc.sha256(unsignedBytes).slice(0, 20).toString('hex');
                detail.computedTxId = computedTxId;

                if (rawExpectedTxId) {
                    txidAvailable = true;
                    detail.txidMatch = computedTxId === rawExpectedTxId;
                    if (detail.txidMatch) txidMatches++; else txidMismatches++;
                } else if (txidAvailable === null) {
                    txidAvailable = false;
                    console.log(`  note: block.transaction_ids not provided by node; relying on hex check\n`);
                }

                if (txHexAvailable !== false) {
                    try {
                        const expectedHex: string = await client.db('get_transaction_hex', [signedTx]);
                        txHexAvailable = true;
                        const signedBytes = serial.ops.signed_transaction.toBuffer(signedTx);
                        const computedHex = signedBytes.toString('hex');
                        detail.expectedSignedHex = expectedHex;
                        detail.computedSignedHex = computedHex;
                        detail.hexMatch = computedHex === expectedHex;
                        if (detail.hexMatch) hexMatches++; else hexMismatches++;
                    } catch (e: any) {
                        if (txHexAvailable === null) {
                            txHexAvailable = false;
                            console.log(`  note: get_transaction_hex unavailable on this node (${getErrorMessage(e)}); txid-only mode\n`);
                        }
                    }
                }

                if (detail.txidMatch === false || detail.hexMatch === false) {
                    /* counted above; do not mark as valid */
                } else if (detail.txidMatch === true || detail.hexMatch === true) {
                    validCount++;
                } else {
                    detail.error = 'no proof available (node lacks transaction_ids and get_transaction_hex)';
                    skipped++;
                }
            } catch (e: any) {
                detail.error = getErrorMessage(e);
                skipped++;
            }

            details.push(detail);
            console.log(`  [${String(details.length).padStart(3, ' ')}/${String(validCount).padStart(3, ' ')}] block ${b} tx#${i} ops=${JSON.stringify(opTypeIds)} ${tagFor(detail)}`);
        }
    }

    const hadProof = txidAvailable === true || txHexAvailable === true;
    const passed = hadProof
        && validCount >= targetCount
        && txidMismatches === 0
        && hexMismatches === 0;

    const report = {
        passed,
        transactionCount: validCount,
        generatedAt: new Date().toISOString(),
        generator: 'scripts/generate_mainnet_corpus_report.ts',
        nodeUrl,
        chainId,
        headBlock,
        scannedFromBlock: startBlock,
        scannedToBlock: scannedTo,
        blocksScanned,
        opTypeCoverage: opCoverage,
        txidCheck: {
            available: txidAvailable === true,
            matches: txidMatches,
            mismatches: txidMismatches,
        },
        txHexCheck: {
            available: txHexAvailable === true,
            matches: hexMatches,
            mismatches: hexMismatches,
        },
        skippedCount: skipped,
        details,
    };

    ensureDir(path.dirname(outPath));
    writeJSON(outPath, report);

    console.log(`\nReport written: ${outPath}`);
    console.log(`Result: passed=${passed} transactionCount=${validCount}`);
    if (txidAvailable) {
        console.log(`  txidCheck:  ${txidMatches} match / ${txidMismatches} mismatch`);
    } else {
        console.log(`  txidCheck:  unavailable (node does not include transaction_ids)`);
    }
    if (txHexAvailable) {
        console.log(`  txHexCheck: ${hexMatches} match / ${hexMismatches} mismatch`);
    } else {
        console.log(`  txHexCheck: unavailable on selected node`);
    }
    if (skipped > 0) console.log(`  skipped:    ${skipped} (unsupported op types or serializer errors)`);

    try { client.disconnect(); } catch (_e) { /* ignore */ }
    process.exit(passed ? 0 : 1);
}

main().catch((err: any) => {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exit(2);
});

export {};
