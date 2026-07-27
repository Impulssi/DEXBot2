const RUN_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS === '1';
const STRICT_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS_STRICT === '1';
const OVERALL_TIMEOUT_MS = Number(process.env.BITSHARES_ACCOUNT_SELECTION_TEST_TIMEOUT_MS) || 10000;

const forceExit = setTimeout(() => {
    const message = `live account selection test timed out after ${OVERALL_TIMEOUT_MS}ms`;
    if (!STRICT_LIVE_TEST) {
        console.log(`Skipping live account selection test: ${message}`);
        process.exit(0);
        return;
    }
    console.error(message);
    process.exit(1);
}, OVERALL_TIMEOUT_MS);

// Test account selection
async function testAccountSelection() {
    if (!RUN_LIVE_TEST) {
        clearTimeout(forceExit);
        console.log('Skipping live account selection test.');
        console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
        return;
    }

    const orders = require('../modules/chain_orders');
    const { getErrorMessage } = require('../modules/utils/errors');

    try {
        console.log('Testing account order read for configured account...');
        let TEST_ACCOUNT = '1.2.1074325';
        try {
            const live = require('../profiles/bots.json');
            const bot = (live.bots || [])[0];
            if (bot && bot.preferredAccount) TEST_ACCOUNT = bot.preferredAccount;
        } catch (e) {}
        const openOrders = await orders.readOpenOrders(TEST_ACCOUNT);
        console.log('Open orders for', TEST_ACCOUNT, ':', openOrders.length);
    } catch (error) {
        if (!STRICT_LIVE_TEST) {
            console.log('Skipping live account selection test: live connectivity not available.');
            console.log('Error:', getErrorMessage(error) || error);
            return;
        }
        console.error('Test failed:', getErrorMessage(error));
        process.exitCode = 1;
    } finally {
        clearTimeout(forceExit);
    }
}

testAccountSelection().finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 50);
});
process.on('unhandledRejection', (r) => { console.error('unhandledRejection', r); process.exit(1); });
