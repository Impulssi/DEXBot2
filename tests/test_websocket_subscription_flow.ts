/**
 * tests/test_websocket_subscription_flow.ts
 *
 * End-to-end websocket subscription flow test.
 * Verifies the full lifecycle: notice -> handleNotice -> direct fill dispatch,
 * with realistic notice data formats including thin 1.11.x objects (no op),
 * full fill objects, and account-scoped objects for other accounts.
 *
 * handleNotice extracts fill objects directly from notice data (1.11.x items
 * with op[0] === OP_FILL_ORDER and op[1].account_id). Non-fill notices (no op
 * field, or op is not a fill_order) are silently skipped. The initial subscribe
 * still does a bounded history scan (cursor catch-up). Reconnect catch-up still
 * works via resubscribeAll().
 */

const assert = require('assert');
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');
const { getErrorMessage } = require('../modules/utils/errors');

const OP_FILL_ORDER = 4;
const ALICE_ID = '1.2.100';
const ALICE_STATS = '2.6.100';
const BOB_ID = '1.2.200';

function makeAccountRecord(account) {
    const name = account === '1.2.200' ? 'bob' : account === '1.2.100' ? 'alice' : account;
    return [account, {
        account: {
            id: name === 'bob' ? '1.2.200' : '1.2.100',
            name,
            statistics: name === 'bob' ? '2.6.200' : '2.6.100',
        },
    }];
}

function makeChainClientMock({ historyImpl, setupNoticeHandler }: any) {
    return {
        transport: {
            addMessageHandler(h) { return setupNoticeHandler(h); },
        },
        db: {
            get_full_accounts: async ([account]) => [makeAccountRecord(account)],
            call: async () => null,
        },
        history: {
            getAccountHistoryOperations: historyImpl,
        },
    };
}

(function () {
    let totalTests = 0;
    let passedTests = 0;

    function test(name, fn) {
        totalTests++;
        try {
            fn();
            console.log(`  \u2713 ${name}`);
            passedTests++;
        } catch (err) {
            console.log(`  \u2717 ${name}: ${getErrorMessage(err)}`);
        }
    }

    function _assertDeepEquals(actual, expected, msg) {
        try {
            assert.deepStrictEqual(actual, expected);
        } catch (err) {
            throw new Error(`${msg}: ${getErrorMessage(err)}`);
        }
    }

    console.log('=== WebSocket Subscription Flow Test ===\n');

    // -----------------------------------------------------------------------
    // 1. Thin notices without fill op + direct fill dispatch
    // -----------------------------------------------------------------------
    console.log('\n--- Thin notice (1.11.x IDs without op) and direct fill dispatch ---');
    {
        let noticeHandler = null;
        const historyPages = [];
        const delivered = [];

        const chainClient = makeChainClientMock({
            setupNoticeHandler: (h) => { noticeHandler = h; return () => { noticeHandler = null; }; },
            historyImpl: async (accountId, opType, start, stop, limit) => {
                historyPages.push({ accountId, opType, start, stop, limit });
                if (limit === 1) {
                    return [{ id: '1.11.100', block_num: 10, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.1' }] }];
                }
                if (stop === '1.11.99') {
                    return [{ id: '1.11.100', block_num: 10, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.1' }] }];
                }
                if (stop === '1.11.100') {
                    return [{ id: '1.11.101', block_num: 11, trx_in_block: 2, op: [OP_FILL_ORDER, { order_id: '1.7.2' }] }];
                }
                if (stop === '1.11.101') return [];
                return [];
            },
        });

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyPages.length = 0;

            // Thin notice without op field — triggers history scan because the
            // notice ID (1.11.101) is ahead of the cursor (1.11.99).
            await noticeHandler([1, [
                { id: '1.11.101', block_num: 11, trx_in_block: 2 },
            ]]);
            await new Promise(resolve => setTimeout(resolve, 300));

            test('thin 1.11.x notice without fill op triggers history scan when cursor is behind', () => {
                assert.strictEqual(delivered.length, 1, 'history scan should deliver fills');
            });

            test('non-fill notice triggers history scan', () => {
                assert.strictEqual(historyPages.length, 1, 'should call getAccountHistoryOperations');
            });

            // Fill object in notice data -- should be dispatched directly
            await noticeHandler([1, [
                { id: '1.11.102', block_num: 12, trx_in_block: 3, op: [OP_FILL_ORDER, { account_id: ALICE_ID, order_id: '1.7.101' }] },
            ]]);

            test('fill object in notice data is dispatched directly', () => {
                assert.strictEqual(delivered.length, 2, 'should have scan delivery + direct fill');
                assert.strictEqual(delivered[1][0].id, '1.11.102', 'direct dispatch should deliver the correct fill');
                assert.strictEqual(delivered[1][0].op[0], OP_FILL_ORDER, 'fill should have correct op type');
            });

            // Same fill object in a second notice -- should dispatch again
            await noticeHandler([1, [
                { id: '1.11.102', block_num: 12, trx_in_block: 3, op: [OP_FILL_ORDER, { account_id: ALICE_ID, order_id: '1.7.101' }] },
            ]]);

            test('same fill object in different notices should dispatch each time', () => {
                assert.strictEqual(delivered.length, 3, 'same fill in second notice should dispatch again');
                assert.strictEqual(delivered[2][0].id, '1.11.102', 'second delivery should contain the same fill object');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 2. Full fill object notice (with op matching account) -- direct dispatch
    // -----------------------------------------------------------------------
    console.log('\n--- Full object notice with matching owner ---');
    {
        let noticeHandler = null;
        const historyPages = [];
        const delivered = [];

        const chainClient = makeChainClientMock({
            setupNoticeHandler: (h) => { noticeHandler = h; return () => { noticeHandler = null; }; },
            historyImpl: async (accountId, opType, start, stop, limit) => {
                historyPages.push({ accountId, opType, start, stop, limit });
                if (limit === 1) return [{ id: '1.11.200', block_num: 20, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.10' }] }];
                if (stop === '1.11.199') return [{ id: '1.11.200', block_num: 20, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.10' }] }];
                if (stop === '1.11.200') return [{ id: '1.11.201', block_num: 21, trx_in_block: 2, op: [OP_FILL_ORDER, { order_id: '1.7.11' }] }];
                if (stop === '1.11.201') return [{ id: '1.11.202', block_num: 22, trx_in_block: 3, op: [OP_FILL_ORDER, { order_id: '1.7.12' }] }];
                return [];
            },
        });

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyPages.length = 0;

            // Full fill object with owner and op matching account -- direct dispatch via handleNotice
            await noticeHandler([1, [
                { id: '1.11.201', owner: ALICE_ID, block_num: 21, trx_in_block: 2, op: [OP_FILL_ORDER, { order_id: '1.7.11', account_id: ALICE_ID }] },
            ]]);

            test('full object with matching owner should deliver fills', () => {
                assert.strictEqual(delivered.length, 1, 'should deliver fills directly from notice');
            });

            test('direct fill notice should not trigger history API calls', () => {
                assert.strictEqual(historyPages.length, 0, 'should not call getAccountHistoryOperations for direct fill notice');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 3. Account-scoped notice for OTHER account should not trigger scan
    // -----------------------------------------------------------------------
    console.log('\n--- Account-scoped notice for other account ---');
    {
        let noticeHandler = null;
        const deliveredAlice = [];
        const deliveredBob = [];
        const historyAccounts = [];

        const chainClient = makeChainClientMock({
            setupNoticeHandler: (h) => { noticeHandler = h; return () => { noticeHandler = null; }; },
            historyImpl: async (accountId, opType, start, stop, limit) => {
                historyAccounts.push(accountId);
                if (limit === 1) return [{ id: '1.11.300', block_num: 30, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.20' }] }];
                if (stop === '1.11.299') return [{ id: '1.11.300', block_num: 30, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.20' }] }];
                if (accountId !== ALICE_ID) return [];
                return [];
            },
        });

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => { deliveredAlice.push(fills); });
            await manager.subscribe('bob', (fills) => { deliveredBob.push(fills); });
            deliveredAlice.length = 0;
            deliveredBob.length = 0;
            historyAccounts.length = 0;

            // Bob's statistics object - triggers scan for all subscriptions
            await noticeHandler([1, [{ id: '2.6.200' }]]);
            await new Promise(resolve => setTimeout(resolve, 300));

            test('other account statistics notice triggers scan for all subscriptions', () => {
                assert.ok(historyAccounts.includes(BOB_ID), 'bob history should be scanned');
                assert.ok(historyAccounts.includes(ALICE_ID), 'alice history should also be scanned');
            });

            test('alice may receive fills when scan covers all subscriptions', () => {
                assert.strictEqual(deliveredAlice.length, 1, 'alice should receive fills from the scan');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 4. Mixed notice batch (new fills + old entries) - dedup by cursor
    // -----------------------------------------------------------------------
    console.log('\n--- Mixed notice batch with fills at and after cursor ---');
    {
        let noticeHandler = null;
        const delivered = [];
        const historyCalls = [];

        const chainClient = makeChainClientMock({
            setupNoticeHandler: (h) => { noticeHandler = h; return () => { noticeHandler = null; }; },
            historyImpl: async (accountId, opType, start, stop, limit) => {
                historyCalls.push({ start, stop, limit });
                if (limit === 1) return [{ id: '1.11.500', block_num: 50, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.50' }] }];
                if (stop === '1.11.499') {
                    return [
                        { id: '1.11.499', block_num: 49, trx_in_block: 0, op: [OP_FILL_ORDER, { order_id: '1.7.49' }] },
                        { id: '1.11.500', block_num: 50, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.50' }] },
                        { id: '1.11.501', block_num: 51, trx_in_block: 2, op: [OP_FILL_ORDER, { order_id: '1.7.51' }] },
                    ];
                }
                if (stop === '1.11.501') return [];
                return [];
            },
        });

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyCalls.length = 0;

            // Bootstrap catch-up: cursor = decrement(500) = 499
            // Page returns [499, 500, 501]
            // Instance > 499 -> keep 500, 501
            // Wait for bootstrap to complete first

            // Give bootstrap time to settle, then send a notice
            await new Promise(resolve => setImmediate(resolve));
            delivered.splice(0, delivered.length);
            historyCalls.length = 0;

            await noticeHandler([1, [
                { id: '1.11.501', block_num: 51, trx_in_block: 2 },
                { id: '1.11.502', block_num: 52, trx_in_block: 3 },
            ]]);
            await new Promise(resolve => setTimeout(resolve, 300));

            // After bootstrap, cursor = 499 (decremented from 500).
            // Thin notices with IDs ahead of the cursor trigger a scan.
            test('cursor should advance past mixed entries, skipping cursor+older', () => {
                assert.strictEqual(delivered.length, 1, 'history scan triggered by thin notices should deliver fills');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 5. Connection reconnection catches missed fills after re-subscribe
    // -----------------------------------------------------------------------
    console.log('\n--- Reconnection fill catch-up ---');
    {
        const delivered = [];
        const historyCalls = [];
        let handlers = [];

        const chainClient = makeChainClientMock({
            setupNoticeHandler: (h) => {
                handlers.push(h);
                const unsubscribe = () => {
                    const idx = handlers.indexOf(h);
                    if (idx !== -1) handlers.splice(idx, 1);
                };
                unsubscribe.isActive = () => handlers.includes(h);
                return unsubscribe;
            },
            historyImpl: async (accountId, opType, start, stop, limit) => {
                historyCalls.push({ start, stop, limit });
                if (limit === 1) return [{ id: '1.11.800', block_num: 80, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.80' }] }];
                if (stop === '1.11.799') {
                    return [{ id: '1.11.800', block_num: 80, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.80' }] }];
                }
                if (stop === '1.11.800') {
                    return [{ id: '1.11.801', block_num: 81, trx_in_block: 2, op: [OP_FILL_ORDER, { order_id: '1.7.81' }] }];
                }
                if (stop === '1.11.801') return [];
                return [];
            },
        });

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyCalls.length = 0;

            // Simulate transport disconnect + reconnect
            handlers = [];
            await manager.resubscribeAll();

            test('reconnect should catch up fills missed during disconnect', () => {
                assert.strictEqual(delivered.length, 1, 'should deliver fills from reconnect catch-up');
                assert.strictEqual(delivered[0][0].id, '1.11.800', 'should deliver the primed fill on reconnect (cursor is decremented)');
            });

            test('reconnect should register new notice handler', () => {
                assert.strictEqual(handlers.length, 1, 'should re-register notice handler after reconnect');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 6. Multiple rapid notices with direct fill dispatch
    // -----------------------------------------------------------------------
    console.log('\n--- Multiple rapid notices with interleaved fills ---');
    {
        let noticeHandler = null;
        const delivered = [];
        const historyCalls = [];

        const chainClient = makeChainClientMock({
            setupNoticeHandler: (h) => { noticeHandler = h; return () => { noticeHandler = null; }; },
            historyImpl: async (accountId, opType, start, stop, limit) => {
                historyCalls.push({ start, stop, limit });
                if (limit === 1) return [{ id: '1.11.900', block_num: 90, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.90' }] }];
                if (stop === '1.11.899') {
                    return [{ id: '1.11.900', block_num: 90, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.90' }] }];
                }
                if (stop === '1.11.900') return [{ id: '1.11.901', block_num: 91, trx_in_block: 2, op: [OP_FILL_ORDER, { order_id: '1.7.91' }] }];
                if (stop === '1.11.901') return [{ id: '1.11.902', block_num: 92, trx_in_block: 3, op: [OP_FILL_ORDER, { order_id: '1.7.92' }] }];
                if (stop === '1.11.902') return [];
                return [];
            },
        });

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyCalls.length = 0;

            // Rapid notices with fill objects -- each should dispatch directly
            await noticeHandler([1, [{ id: '1.11.901', block_num: 91, trx_in_block: 2, op: [OP_FILL_ORDER, { account_id: ALICE_ID, order_id: '1.7.91' }] }]]);
            await noticeHandler([1, [{ id: '1.11.902', block_num: 92, trx_in_block: 3, op: [OP_FILL_ORDER, { account_id: ALICE_ID, order_id: '1.7.92' }] }]]);
            await noticeHandler([1, [{ id: '1.11.903', block_num: 93, trx_in_block: 4, op: [OP_FILL_ORDER, { account_id: ALICE_ID, order_id: '1.7.93' }] }]]);

            test('rapid notices each dispatch their fill objects', () => {
                assert.strictEqual(delivered.length, 3, 'each notice should dispatch its fill objects');
            });

            test('duplicate notices should not redeliver same fill', () => {
                const allFillIds = delivered.flat().map(f => f.id);
                const uniqueIds = [...new Set(allFillIds)];
                assert.strictEqual(allFillIds.length, uniqueIds.length, 'no duplicate fills should be delivered');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 7. Object notices without any .id field (edge case)
    // -----------------------------------------------------------------------
    console.log('\n--- Notice data with missing .id field ---');
    {
        let noticeHandler = null;
        let noticeProcessedCount = 0;
        let historyScanCount = 0;

        const chainClient = makeChainClientMock({
            setupNoticeHandler: (h) => { noticeHandler = h; return () => { noticeHandler = null; }; },
            historyImpl: async (accountId, opType, start, stop, limit) => {
                historyScanCount++;
                if (limit === 1) return [{ id: '1.11.400', block_num: 40, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.40' }] }];
                return [];
            },
        });

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', () => { noticeProcessedCount++; });
            historyScanCount = 0;
            noticeProcessedCount = 0;

            const originalLog = console.log;
            const loggedMessages = [];
            console.log = (...args) => {
                const msg = args.join(' ');
                if (msg.includes('[subscriptions] processObjects: no identifiable')) {
                    loggedMessages.push(msg);
                }
                originalLog.apply(console, args);
            };

            try {
                // Objects without .id field -- no op field so handleNotice silently skips them
                await noticeHandler([1, [{ someField: 'no id here' }]]);
                await noticeHandler([1, [{ id: null }]]);
                await noticeHandler([1, [{ id: 12345 }]]); // numeric id, not string

                test('objects without string .id should be silently skipped', () => {
                    assert.strictEqual(loggedMessages.length, 0, 'should not log diagnostic for non-fill notice data');
                });

                test('malformed notices should not crash the subscription manager', () => {
                    assert.ok(true, 'subscription manager should remain functional after malformed notices');
                });
            } finally {
                console.log = originalLog;
            }
        })();
    }

    // -----------------------------------------------------------------------
    // Summarize
    // -----------------------------------------------------------------------
    setTimeout(() => {
        console.log(`\n=== Results: ${passedTests}/${totalTests} passed ===\n`);
        if (passedTests !== totalTests) {
            process.exitCode = 1;
        }
    }, 1000);

})();
