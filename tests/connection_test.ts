'use strict';

const { getErrorMessage } = require('../modules/utils/errors');
const RUN_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS === '1';
const CONNECT_TIMEOUT_MS = Number(process.env.BITSHARES_CONNECTION_TEST_TIMEOUT_MS) || 5000;
const STRICT_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS_STRICT === '1';
const OVERALL_TIMEOUT_MS = Number(process.env.BITSHARES_CONNECTION_TEST_OVERALL_TIMEOUT_MS) || 15000;

function formatError(error) {
    return error && getErrorMessage(error) ? getErrorMessage(error) : String(error);
}

function createRejectionGuard() {
    let rejectGuard;
    const guard = new Promise((_, reject) => {
        rejectGuard = reject;
    });

    const handler = (reason) => {
        rejectGuard(reason instanceof Error ? reason : new Error(formatError(reason)));
    };

    process.on('unhandledRejection', handler);

    return {
        guard,
        cleanup() {
            process.off('unhandledRejection', handler);
        }
    };
}

async function testConnection() {
    if (!RUN_LIVE_TEST) {
        console.log('Skipping live BitShares connection test.');
        console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
        return;
    }

    const { BitShares, waitForConnected } = require('../modules/bitshares_client');

    console.log('Testing BitShares connection with native client (shared client)...');

    const rejectionGuard = createRejectionGuard();
    let timeoutHandle = null;

    try {
        await Promise.race([
            Promise.race([
                waitForConnected(CONNECT_TIMEOUT_MS),
                rejectionGuard.guard
            ]),
            new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`live connection test timed out after ${OVERALL_TIMEOUT_MS}ms`));
                }, OVERALL_TIMEOUT_MS);
            })
        ]);

        console.log('Connected to BitShares API');

        const globalProps = await BitShares.db.get_dynamic_global_properties();
        console.log('Dynamic global properties retrieved');
        console.log('Head block number:', globalProps.head_block_number);

        const btsAsset = await BitShares.assets.bts;
        console.log('BTS asset retrieved');
        console.log('BTS precision:', btsAsset.precision);

        console.log('All connection tests passed!');
    } catch (error) {
        const message = formatError(error);
        if (!STRICT_LIVE_TEST) {
            console.log('Skipping live BitShares connection test: live connectivity not available.');
            console.log('Error:', message);
            return;
        }
        console.error('Connection test failed:', message);
        process.exitCode = 1;
        return;
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        rejectionGuard.cleanup();
    }
}

testConnection().catch((error) => {
    console.error('Connection test failed:', formatError(error));
    process.exitCode = 1;
}).finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 50);
});
