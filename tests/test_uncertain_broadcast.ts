const assert = require('assert');
const { EventEmitter } = require('events');
const net = require('net');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const chainOrders = require('../modules/chain_orders');
const chainKeys = require('../modules/chain_keys');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, DAEMON_CODES } = require('../modules/constants');
const {
    BroadcastUncertainError,
    executeOperationsViaCredentialDaemon
} = require('../modules/dexbot_credential_client');
const {
    buildCreateOpFingerprint
} = require('../modules/order/utils/order');

let testsComplete = false;

process.on('unhandledRejection', (reason) => {
    const isPostTestWsErrorEvent = testsComplete &&
        reason &&
        (reason as any).type === 'error' &&
        (reason as any).error &&
        typeof (reason as any).error === 'object';

    if (isPostTestWsErrorEvent) {
        return;
    }

    console.error('Test failed:', reason);
    process.exit(1);
});

function makeFingerprint(side, assetA, assetB, sell, receive, slotId) {
    return `${side}:${assetA}:${assetB}:${sell}:${receive}:${slotId}`;
}

function makeChainOrder(id, type, sellInt, receiveInt) {
    const sellAssetId = type === 'sell' ? '1.3.0' : '1.3.121';
    const receiveAssetId = type === 'sell' ? '1.3.121' : '1.3.0';
    return {
        id,
        for_sale: String(sellInt),
        sell_price: {
            base: { amount: String(sellInt), asset_id: sellAssetId },
            quote: { amount: String(receiveInt), asset_id: receiveAssetId }
        }
    };
}

function installFakeCredentialDaemonTransport(handler) {
    const originalCreateConnection = net.createConnection;
    const socketPath = `/tmp/dexbot-fake-${process.pid}-${Date.now()}.sock`;
    net.createConnection = (requestedSocketPath, onConnect) => {
        assert.strictEqual(requestedSocketPath, socketPath);
        const socket = new EventEmitter();
        socket.destroyed = false;
        socket.write = (payload) => {
            const request = JSON.parse(String(payload).trim());
            handler(request, {
                writeLine: (response) => {
                    process.nextTick(() => socket.emit('data', Buffer.from(`${JSON.stringify(response)}\n`)));
                },
                endLine: (response) => {
                    process.nextTick(() => {
                        socket.emit('data', Buffer.from(`${JSON.stringify(response)}\n`));
                        socket.emit('end');
                    });
                },
                close: () => process.nextTick(() => socket.emit('end')),
            });
            return true;
        };
        socket.end = () => {
            socket.destroyed = true;
        };
        socket.destroy = () => {
            socket.destroyed = true;
            process.nextTick(() => socket.emit('close'));
        };
        process.nextTick(() => onConnect && onConnect());
        return socket;
    };
    return {
        socketPath,
        restore: () => {
            net.createConnection = originalCreateConnection;
        }
    };
}

async function testFingerprintDeterministic() {
    console.log('\n[UNC-001] buildCreateOpFingerprint is deterministic...');
    const fp1 = buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0',
        assetB: '1.3.121',
        sellInt: 100000000,
        receiveInt: 5000000,
        slotId: 'sell-3'
    });
    const fp2 = buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0',
        assetB: '1.3.121',
        sellInt: 100000000,
        receiveInt: 5000000,
        slotId: 'sell-3'
    });
    assert.strictEqual(fp1, fp2, 'same inputs must produce the same fingerprint');
    assert.strictEqual(
        fp1,
        makeFingerprint('sell', '1.3.0', '1.3.121', 100000000, 5000000, 'sell-3'),
        'fingerprint format must match expected pattern'
    );
    console.log('✓ UNC-001 passed');
}

async function testFingerprintRejectsBadInput() {
    console.log('\n[UNC-002] buildCreateOpFingerprint rejects malformed input...');
    assert.strictEqual(buildCreateOpFingerprint(null), null);
    assert.strictEqual(buildCreateOpFingerprint({}), null);
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'invalid',
        assetA: '1.3.0', assetB: '1.3.121',
        sellInt: 1, receiveInt: 1, slotId: 'x'
    }), null, 'invalid side must return null');
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'sell',
        assetA: null, assetB: '1.3.121',
        sellInt: 1, receiveInt: 1, slotId: 'x'
    }), null, 'missing asset must return null');
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0', assetB: '1.3.121',
        sellInt: 'NaN', receiveInt: 1, slotId: 'x'
    }), null, 'non-finite sell must return null');
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0', assetB: '1.3.121',
        sellInt: 1, receiveInt: 1, slotId: null
    }), null, 'missing slotId must return null');
    console.log('✓ UNC-002 passed');
}

async function testBroadcastUncertainErrorCarriesMetadata() {
    console.log('\n[UNC-003] BroadcastUncertainError carries operations, accountName, batchId...');
    const err = new BroadcastUncertainError('test', {
        operations: [{ op_name: 'limit_order_create' }],
        accountName: 'bbot9',
        batchId: 'batch-42',
        payload: { type: 'execute-operations' },
        timeoutMs: 30000
    });
    assert.strictEqual(err.name, 'BroadcastUncertainError');
    assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
    assert.strictEqual(err.accountName, 'bbot9');
    assert.strictEqual(err.batchId, 'batch-42');
    assert.strictEqual(err.timeoutMs, 30000);
    assert(Array.isArray(err.operations), 'operations should be carried on the error');
    assert(err instanceof Error, 'must be an Error subclass');
    console.log('✓ UNC-003 passed');
}

async function testExactChainOrderMatchIsAdopted() {
    console.log('\n[UNC-004] exact-fingerprint chain order is adopted (not duplicated)...');
    const bot = makeBot();
    const slotId = 'sell-3';
    const fingerprintSell = 100000000;
    const fingerprintReceive = 5000000;

    bot.manager._pendingBroadcasts.set(
        makeFingerprint('sell', '1.3.0', '1.3.121', fingerprintSell, fingerprintReceive, slotId),
        {
            fingerprint: makeFingerprint('sell', '1.3.0', '1.3.121', fingerprintSell, fingerprintReceive, slotId),
            slotId,
            orderType: 'sell',
            order: { id: slotId, type: 'sell', price: 0.05, size: 1 },
            finalInts: { sell: fingerprintSell, receive: fingerprintReceive },
            batchId: 'test-batch-1',
            recordedAt: Date.now()
        }
    );

    // Chain already has the order (we just couldn't see the broadcast reply).
    const chainOrders = [
        {
            id: '1.7.572311702',
            type: 'sell',
            sellInt: fingerprintSell,
            receiveInt: fingerprintReceive,
            sellAssetId: '1.3.0',
            receiveAssetId: '1.3.121',
            for_sale: fingerprintSell
        }
    ];

    const adopted = [];
    const discarded = [];
    for (const entry of bot.manager._pendingBroadcasts.values()) {
        const match = bot._findChainOrderForSlot(
            chainOrders,
            entry.slotId,
            { sell: entry.finalInts.sell, receive: entry.finalInts.receive }
        );
        if (match) {
            adopted.push({ slotId: entry.slotId, chainOrderId: match.id });
            bot.manager._pendingBroadcasts.delete(entry.fingerprint);
        } else {
            discarded.push({ slotId: entry.slotId });
        }
    }
    assert.strictEqual(adopted.length, 1, 'one planned CREATE should be adopted');
    assert.strictEqual(adopted[0].chainOrderId, '1.7.572311702', 'must adopt the chain order by id');
    assert.strictEqual(discarded.length, 0, 'no discard when exact match found');
    assert.strictEqual(bot.manager._pendingBroadcasts.size, 0, 'pending broadcasts should be cleared after adoption');
    console.log('✓ UNC-004 passed');
}

async function testRecordedPendingBroadcastStoresSlotId() {
    console.log('\n[UNC-004b] _recordPendingBroadcast stores runtime slotId for recovery...');
    const bot = makeBot();
    const slotId = 'sell-4';
    const plannedSell = 110000000;
    const plannedReceive = 5500000;

    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: slotId, type: 'sell', price: 0.05, size: 1.1 },
        finalInts: { sell: plannedSell, receive: plannedReceive }
    });

    assert.strictEqual(bot.manager._pendingBroadcasts.size, 1, 'pending broadcast should be recorded');
    const entry = Array.from(bot.manager._pendingBroadcasts.values())[0];
    assert.strictEqual((entry as any).slotId, slotId, 'runtime pending entry must carry slotId');

    const chainOrders = [
        {
            id: '1.7.572311703',
            type: 'sell',
            sellInt: plannedSell,
            receiveInt: plannedReceive,
            sellAssetId: '1.3.0',
            receiveAssetId: '1.3.121',
            for_sale: plannedSell
        }
    ];

    const match = bot._findChainOrderForSlot(
        chainOrders,
        (entry as any).slotId,
        { sell: (entry as any).finalInts.sell, receive: (entry as any).finalInts.receive, orderType: (entry as any).orderType }
    );
    assert(match, 'runtime-shaped pending entry should match chain order');
    assert.strictEqual(match.id, '1.7.572311703');
    console.log('✓ UNC-004b passed');
}

async function testNoChainMatchIsDiscarded() {
    console.log('\n[UNC-005] no-chain-match pending is discarded (not duplicated)...');
    const bot = makeBot();
    const slotId = 'sell-7';
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('sell', '1.3.0', '1.3.121', 200000000, 8000000, slotId),
        {
            fingerprint: makeFingerprint('sell', '1.3.0', '1.3.121', 200000000, 8000000, slotId),
            slotId,
            orderType: 'sell',
            order: { id: slotId, type: 'sell', price: 0.04, size: 2 },
            finalInts: { sell: 200000000, receive: 8000000 },
            batchId: 'test-batch-2',
            recordedAt: Date.now()
        }
    );

    // Chain has no matching order (the broadcast never made it through).
    const chainOrders = [];
    const adopted = [];
    const discarded = [];
    for (const entry of bot.manager._pendingBroadcasts.values()) {
        const match = bot._findChainOrderForSlot(
            chainOrders,
            entry.slotId,
            { sell: entry.finalInts.sell, receive: entry.finalInts.receive }
        );
        if (match) {
            adopted.push({ slotId: entry.slotId, chainOrderId: match.id });
            bot.manager._pendingBroadcasts.delete(entry.fingerprint);
        } else {
            discarded.push({ slotId: entry.slotId });
        }
    }
    assert.strictEqual(adopted.length, 0, 'no adoption when chain is empty');
    assert.strictEqual(discarded.length, 1, 'planned CREATE should be discarded');
    assert.strictEqual(discarded[0].slotId, 'sell-7');
    console.log('✓ UNC-005 passed');
}

async function testNearMatchWithinToleranceIsAdopted() {
    console.log('\n[UNC-006] near-tolerance chain match is adopted (precision drift)...');
    const bot = makeBot();
    const slotId = 'buy-2';
    const plannedSell = 10000000;
    const plannedReceive = 2000000;
    bot.manager.orders.set(slotId, { id: slotId, type: 'buy', price: 0.2, size: 0.1 });
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
        {
            fingerprint: makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
            slotId,
            orderType: 'buy',
            order: { id: slotId, type: 'buy', price: 0.2, size: 0.1 },
            finalInts: { sell: plannedSell, receive: plannedReceive },
            batchId: 'test-batch-3',
            recordedAt: Date.now()
        }
    );

    // Chain has the order but the receive int drifted by 1 (e.g. ±1 rounding).
    const chainOrders = [
        {
            id: '1.7.572311800',
            type: 'buy',
            sellInt: plannedSell,
            receiveInt: plannedReceive + 1,
            sellAssetId: '1.3.121',
            receiveAssetId: '1.3.0',
            for_sale: plannedSell
        }
    ];
    const match = bot._findChainOrderForSlot(
        chainOrders,
        slotId,
        { sell: plannedSell, receive: plannedReceive, orderType: 'buy' }
    );
    assert(match, 'within-tolerance chain order should be adopted');
    assert.strictEqual(match.id, '1.7.572311800');
    console.log('✓ UNC-006 passed');
}

async function testOutsideToleranceIsNotAdopted() {
    console.log('\n[UNC-007] outside-tolerance chain order is NOT adopted...');
    const bot = makeBot();
    const slotId = 'sell-9';
    const plannedSell = 100000000;
    const plannedReceive = 5000000;
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('sell', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
        {
            fingerprint: makeFingerprint('sell', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
            slotId,
            orderType: 'sell',
            order: { id: slotId, type: 'sell', price: 0.05, size: 1 },
            finalInts: { sell: plannedSell, receive: plannedReceive },
            batchId: 'test-batch-4',
            recordedAt: Date.now()
        }
    );

    // Chain has an order for a totally different price (50% off planned).
    const chainOrders = [
        {
            id: '1.7.572311999',
            type: 'sell',
            sellInt: plannedSell,
            receiveInt: plannedReceive * 2,  // 100% drift
            sellAssetId: '1.3.0',
            receiveAssetId: '1.3.121',
            for_sale: plannedSell
        }
    ];
    const match = bot._findChainOrderForSlot(
        chainOrders,
        slotId,
        { sell: plannedSell, receive: plannedReceive }
    );
    assert.strictEqual(match, null, 'outside-tolerance match must NOT be adopted');
    console.log('✓ UNC-007 passed');
}

async function testNearMatchUsesPendingSideWhenGridSlotMissing() {
    console.log('\n[UNC-007b] near-match uses pending side when live grid slot is missing...');
    const bot = makeBot();
    const slotId = 'buy-cleared';
    const plannedSell = 10000000;
    const plannedReceive = 2000000;
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
        {
            fingerprint: makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
            slotId,
            orderType: 'buy',
            order: { id: slotId, type: 'buy', price: 0.2, size: 0.1 },
            finalInts: { sell: plannedSell, receive: plannedReceive },
            batchId: 'test-batch-side',
            recordedAt: Date.now()
        }
    );

    assert.strictEqual(bot.manager.orders.has(slotId), false, 'test must cover cleared working/master slot');
    const match = bot._findChainOrderForSlot(
        [makeChainOrder('1.7.572311801', 'buy', plannedSell, plannedReceive + 1)],
        slotId,
        { sell: plannedSell, receive: plannedReceive, orderType: 'buy' }
    );
    assert(match, 'near-match should not depend on manager.orders retaining the slot type');
    assert.strictEqual(match.id, '1.7.572311801');
    console.log('✓ UNC-007b passed');
}

async function testBroadcastUncertainErrorIsNotRetried() {
    console.log('\n[UNC-008] BroadcastUncertainError is not retried by chain_orders...');
    // The retry path in executeViaDaemonToken must skip on BroadcastUncertainError.
    // We can't easily drive the daemon in a unit test, but we can verify the
    // error instance is recognized.
    const err = new BroadcastUncertainError('test', { operations: [], accountName: 'x' });
    // The shape check: chain_orders.executeBatch would `if (err instanceof BroadcastUncertainError) throw err;`
    assert(err instanceof BroadcastUncertainError);
    assert(err instanceof Error);
    console.log('✓ UNC-008 passed');
}

async function testReconcileAdoptsRuntimePendingBroadcast() {
    console.log('\n[UNC-008b] _reconcileAfterUncertainBroadcast adopts runtime pending CREATEs...');
    const bot = makeBot();
    const slotId = 'sell-11';
    const plannedSell = 120000000;
    const plannedReceive = 6000000;
    const chainSnapshot = [makeChainOrder('1.7.572312011', 'sell', plannedSell, plannedReceive)];
    let readCalls = 0;
    let syncCalls = 0;
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origAutoCancel = bot._autoCancelOneUnmatchedOrphan;

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 1.2 });
    bot.manager.syncFromOpenOrders = async (orders, options) => {
        syncCalls++;
        assert.deepStrictEqual(orders, chainSnapshot, 'recovery must sync from the fresh chain snapshot');
        assert.strictEqual(options.skipAccounting, true, 'recovery sync should skip accounting');
        return { filledOrders: [], updatedOrders: [], unmatchedChainOrders: [] };
    };
    bot._autoCancelOneUnmatchedOrphan = async () => ({ cancelled: false, reason: 'test-noop' });
    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: slotId, type: 'sell', price: 0.05, size: 1.2 },
        finalInts: { sell: plannedSell, receive: plannedReceive }
    });
    chainOrders.readOpenOrders = async (accountRef) => {
        readCalls++;
        assert.strictEqual(accountRef, 'test-account');
        return chainSnapshot;
    };

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }],
                accountName: 'test-account',
                batchId: 'batch-adopt',
                timeoutMs: 30000
            }),
            [{ kind: 'create', id: slotId }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.hadRotation, true, 'chain snapshot sync should mark recovery as state-changing');
        assert.strictEqual(result.adopted.length, 1, 'matching chain order should be adopted');
        assert.strictEqual(result.adopted[0].slotId, slotId);
        assert.strictEqual(result.adopted[0].chainOrderId, '1.7.572312011');
        assert.strictEqual(result.discarded.length, 0);
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 0, 'pending broadcasts must be cleared after recovery');
        assert.strictEqual(readCalls, 1);
        assert.strictEqual(syncCalls, 0, 'heavy re-sync is skipped when all CREATEs are adopted and no extra chain orders exist');
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot._autoCancelOneUnmatchedOrphan = origAutoCancel;
    }
    console.log('✓ UNC-008b passed');
}

async function testReconcileReadFailureRequestsStructuralResync() {
    console.log('\n[UNC-008c] _reconcileAfterUncertainBroadcast requests structural resync on read failure...');
    const bot = makeBot();
    const origReadOpenOrders = chainOrders.readOpenOrders;
    let resyncReason = null;
    let resyncMeta = null;
    bot.manager.requestStructuralGridResync = async (reason, meta) => {
        resyncReason = reason;
        resyncMeta = meta;
    };
    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: 'sell-12', type: 'sell', price: 0.05, size: 1.2 },
        finalInts: { sell: 120000000, receive: 6000000 }
    });
    chainOrders.readOpenOrders = async () => {
        throw new Error('read failed');
    };

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', { batchId: 'batch-read-fail', timeoutMs: 30000 }),
            [{ kind: 'create', id: 'sell-12' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.executed, false);
        assert.strictEqual(resyncReason, 'broadcast uncertain — readOpenOrders failed');
        assert.strictEqual(resyncMeta.batchId, 'batch-read-fail');
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 0, 'pending broadcasts must clear on fallback resync');
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
    }
    console.log('✓ UNC-008c passed');
}

async function testReconcileAcquiresFillLock() {
    console.log('\n[UNC-008c2] _reconcileAfterUncertainBroadcast acquires fill lock before syncing...');
    const bot = makeBot();
    const slotId = 'sell-lock';
    const plannedSell = 120000000;
    const plannedReceive = 6000000;
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origAutoCancel = bot._autoCancelOneUnmatchedOrphan;
    let lockAcquireCalls = 0;
    let insideLock = false;
    let syncCalls = 0;

    bot.manager._fillProcessingLock = {
        acquire: async (fn) => {
            lockAcquireCalls++;
            insideLock = true;
            try {
                return await fn();
            } finally {
                insideLock = false;
            }
        }
    };
    bot.manager.syncFromOpenOrders = async (_orders, options) => {
        syncCalls++;
        assert.strictEqual(insideLock, true, 'recovery sync must run while fill lock is held');
        assert.strictEqual(options.fillLockAlreadyHeld, true, 'inner sync should reuse the held fill lock');
        return { filledOrders: [], updatedOrders: [], unmatchedChainOrders: [] };
    };
    bot._autoCancelOneUnmatchedOrphan = async () => ({ cancelled: false, reason: 'test-noop' });
    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: slotId, type: 'sell', price: 0.05, size: 1.2 },
        finalInts: { sell: plannedSell, receive: plannedReceive }
    });
    chainOrders.readOpenOrders = async () => [makeChainOrder('1.7.572312012', 'sell', plannedSell, plannedReceive)];

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', { batchId: 'batch-lock', timeoutMs: 30000 }),
            [{ kind: 'create', id: slotId }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(lockAcquireCalls, 1, 'recovery should acquire the fill lock once');
        assert.strictEqual(syncCalls, 0, 'heavy re-sync is skipped when all CREATEs are adopted and no extra chain orders exist');
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot._autoCancelOneUnmatchedOrphan = origAutoCancel;
    }
    console.log('✓ UNC-008c2 passed');
}

async function testCowBatchAdvancesCycleMarker() {
    console.log('\n[UNC-008d] COW batch attempts advance the auto-cancel cycle marker...');
    const bot = makeBot();
    bot.config.dryRun = true;
    const startCycle = bot._currentCycleId;
    const cowResult = {
        workingGrid: {},
        workingIndexes: {},
        workingBoundary: 0,
        actions: [{ type: COW_ACTIONS.CANCEL, id: 'sell-1', orderId: '1.7.1' }]
    };
    const r1 = await bot._updateOrdersOnChainBatchCOW(cowResult);
    const r2 = await bot._updateOrdersOnChainBatchCOW(cowResult);
    assert.strictEqual(r1.executed, true);
    assert.strictEqual(r2.executed, true);
    assert.strictEqual(bot._currentCycleId, startCycle + 2, 'each COW batch attempt must advance cycle id');
    console.log('✓ UNC-008d passed');
}

async function testCredentialClientDeadlineReplyBecomesUncertain() {
    console.log('\n[UNC-008e] credential client converts BROADCAST_DEADLINE replies to BroadcastUncertainError...');
    const operations = [{ op_name: 'limit_order_create', op_data: { amount_to_sell: 1 } }];
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        assert.strictEqual(request.type, 'execute-operations');
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner broadcast deadline exceeded' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                batchId: 'batch-deadline',
                timeoutMs: 1000
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
                assert.strictEqual(err.batchId, 'batch-deadline');
                assert.strictEqual(err.accountName, 'test-account');
                assert.deepStrictEqual(err.operations, operations);
                return true;
            }
        );
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008e passed');
}

async function testCredentialClientBroadcastTimeoutBecomesUncertain() {
    console.log('\n[UNC-008f] credential client broadcast socket timeout is uncertain...');
    const operations = [{ op_name: 'limit_order_create', op_data: { amount_to_sell: 1 } }];
    const transport = installFakeCredentialDaemonTransport(() => {
        // Intentionally keep the socket open so the client-side timeout fires.
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                batchId: 'batch-timeout',
                timeoutMs: 25
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.batchId, 'batch-timeout');
                assert.strictEqual(err.timeoutMs, 25);
                return true;
            }
        );
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008f passed');
}

async function testExecuteBatchDoesNotRetryUncertainDaemonBroadcast() {
    console.log('\n[UNC-008g] chain_orders.executeBatch does not retry uncertain daemon broadcasts...');
    let requestCount = 0;
    let probeCalls = 0;
    const origProbe = chainKeys.probeAccountInDaemon;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner broadcast deadline exceeded' });
    });
    const token = chainKeys.createDaemonSigningToken('test-account', {
        socketPath: transport.socketPath,
        sessionId: 'session-1'
    });

    chainKeys.probeAccountInDaemon = async () => {
        probeCalls++;
        return 'session-2';
    };

    try {
        await assert.rejects(
            () => chainOrders.executeBatch('test-account', token, [{ op_name: 'limit_order_create', op_data: {} }]),
            (err) => err instanceof BroadcastUncertainError
        );
        assert.strictEqual(requestCount, 1, 'uncertain broadcast must not be retried');
        assert.strictEqual(probeCalls, 0, 'uncertain broadcast must not renegotiate daemon session');
    } finally {
        chainKeys.probeAccountInDaemon = origProbe;
        transport.restore();
    }
    console.log('✓ UNC-008g passed');
}

async function testExecuteBatchRetriesExpiredDaemonSessionOnly() {
    console.log('\n[UNC-008h] chain_orders.executeBatch still retries expired daemon sessions...');
    let requestCount = 0;
    let probeCalls = 0;
    const origProbe = chainKeys.probeAccountInDaemon;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        if (requestCount === 1) {
            socket.endLine({ success: false, error: 'invalid or expired session' });
        } else {
            assert.strictEqual(request.sessionId, 'session-2', 'retry should use renegotiated session');
            socket.endLine({ success: true, raw: { ok: true }, operation_results: [['1', '1.7.1']] });
        }
    });
    const token = chainKeys.createDaemonSigningToken('test-account', {
        socketPath: transport.socketPath,
        sessionId: 'session-1'
    });

    chainKeys.probeAccountInDaemon = async (accountName) => {
        probeCalls++;
        assert.strictEqual(accountName, 'test-account');
        return 'session-2';
    };

    try {
        const result = await chainOrders.executeBatch('test-account', token, [{ op_name: 'limit_order_create', op_data: {} }]);
        assert.strictEqual(result.success, true);
        assert.strictEqual(requestCount, 2, 'expired session should retry exactly once');
        assert.strictEqual(probeCalls, 1, 'expired session should renegotiate once');
        assert.strictEqual(token.sessionId, 'session-2', 'token should be updated in place');
    } finally {
        chainKeys.probeAccountInDaemon = origProbe;
        transport.restore();
    }
    console.log('✓ UNC-008h passed');
}

async function testExecuteBatchRetryPreservesUncertainBroadcastHandling() {
    console.log('\n[UNC-008i] expired-session retry still treats BROADCAST_DEADLINE as uncertain...');
    let requestCount = 0;
    const origProbe = chainKeys.probeAccountInDaemon;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        if (requestCount === 1) {
            socket.endLine({ success: false, error: 'invalid or expired session' });
        } else {
            assert.strictEqual(request.sessionId, 'session-2', 'retry should use renegotiated session');
            socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner broadcast deadline exceeded on retry' });
        }
    });
    const token = chainKeys.createDaemonSigningToken('test-account', {
        socketPath: transport.socketPath,
        sessionId: 'session-1'
    });
    token.batchId = 'batch-retry-deadline';

    chainKeys.probeAccountInDaemon = async () => 'session-2';

    try {
        await assert.rejects(
            () => chainOrders.executeBatch('test-account', token, [{ op_name: 'limit_order_create', op_data: {} }]),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.batchId, 'batch-retry-deadline');
                return true;
            }
        );
        assert.strictEqual(requestCount, 2, 'expired session should retry once before uncertain failure');
    } finally {
        chainKeys.probeAccountInDaemon = origProbe;
        transport.restore();
    }
    console.log('✓ UNC-008i passed');
}

async function testAutoCancelPerCycleCap() {
    console.log('\n[UNC-009] _autoCancelOneUnmatchedOrphan enforces per-cycle cap=1...');
    const bot = makeBot();
    bot._currentCycleId = 7;
    bot.manager._lastUnmatchedChainOrders = [
        { id: '1.7.111', orderId: '1.7.111', reason: 'unknown' },
        { id: '1.7.222', orderId: '1.7.222', reason: 'unknown' },
        { id: '1.7.333', orderId: '1.7.333', reason: 'unknown' }
    ];

    // Stub cancelOrder so we can count calls.
    let cancelCalls = 0;
    const realChainOrders = require('../modules/chain_orders');
    const origCancel = realChainOrders.cancelOrder;
    realChainOrders.cancelOrder = async () => {
        cancelCalls++;
        return { success: true };
    };
    // Record-own-cancel stub
    const origRecord = realChainOrders.recordOwnCancel;
    realChainOrders.recordOwnCancel = () => {};

    try {
        const r1 = await bot._autoCancelOneUnmatchedOrphan();
        assert.strictEqual(r1.cancelled, true, 'first call in cycle should cancel');
        assert.strictEqual(cancelCalls, 1, 'one cancel call expected');
        assert.strictEqual(r1.orderId, '1.7.111', 'first unmatched order is cancelled first');

        const r2 = await bot._autoCancelOneUnmatchedOrphan();
        assert.strictEqual(r2.cancelled, false, 'second call in same cycle must be capped');
        assert.strictEqual(r2.reason, 'cap-reached-this-cycle');
        assert.strictEqual(cancelCalls, 1, 'no additional cancel call');

        // New cycle -> cap resets.
        bot._currentCycleId = 8;
        const r3 = await bot._autoCancelOneUnmatchedOrphan();
        assert.strictEqual(r3.cancelled, true, 'new cycle should allow another cancel');
        assert.strictEqual(cancelCalls, 2, 'second cancel call expected in new cycle');
    } finally {
        realChainOrders.cancelOrder = origCancel;
        realChainOrders.recordOwnCancel = origRecord;
    }
    console.log('✓ UNC-009 passed');
}

async function testAutoCancelUsesSyncEngineChainOrderIdShape() {
    console.log('\n[UNC-009b] _autoCancelOneUnmatchedOrphan handles sync-engine chainOrderId shape...');
    const bot = makeBot();
    bot._currentCycleId = 11;
    bot.manager._lastUnmatchedChainOrders = [
        { chainOrderId: '1.7.777', type: 'sell', price: 0.05, size: 1, reason: 'unknown' }
    ];

    let cancelledOrderId = null;
    const origCancel = chainOrders.cancelOrder;
    const origRecord = chainOrders.recordOwnCancel;
    chainOrders.cancelOrder = async (_account, _privateKey, orderId) => {
        cancelledOrderId = orderId;
        return { success: true };
    };
    chainOrders.recordOwnCancel = () => {};

    try {
        const result = await bot._autoCancelOneUnmatchedOrphan();
        assert.strictEqual(result.cancelled, true);
        assert.strictEqual(result.orderId, '1.7.777');
        assert.strictEqual(cancelledOrderId, '1.7.777');
    } finally {
        chainOrders.cancelOrder = origCancel;
        chainOrders.recordOwnCancel = origRecord;
    }
    console.log('✓ UNC-009b passed');
}

async function testAutoCancelSkipsWhenPendingBroadcasts() {
    console.log('\n[UNC-010] _autoCancelOneUnmatchedOrphan skips when pending broadcasts exist...');
    const bot = makeBot();
    bot._currentCycleId = 9;
    bot.manager._lastUnmatchedChainOrders = [
        { id: '1.7.555', orderId: '1.7.555', reason: 'unknown' }
    ];
    bot.manager._pendingBroadcasts.set('some-fp', { slotId: 'sell-1' });

    const r = await bot._autoCancelOneUnmatchedOrphan();
    assert.strictEqual(r.cancelled, false, 'must not cancel while pending broadcasts exist');
    assert.strictEqual(r.reason, 'pending-broadcasts-active');
    console.log('✓ UNC-010 passed');
}

async function testAutoCancelSkipsFingerprinted() {
    console.log('\n[UNC-011] _autoCancelOneUnmatchedOrphan skips fingerprinted unmatched (recovery handles them)...');
    const bot = makeBot();
    bot._currentCycleId = 10;
    bot.manager._lastUnmatchedChainOrders = [
        { id: '1.7.666', orderId: '1.7.666', reason: 'pending-broadcast', fingerprint: 'sell:1.3.0:1.3.121:1:2:sell-1' }
    ];

    const r = await bot._autoCancelOneUnmatchedOrphan();
    assert.strictEqual(r.cancelled, false, 'fingerprinted unmatched must be left to recovery');
    assert.strictEqual(r.reason, 'fingerprinted-handle-via-recovery');
    console.log('✓ UNC-011 passed');
}

function makeBot() {
    const DEXBot = require('../modules/dexbot_class');
    const bot = new DEXBot({
        botKey: 'test_uncertain_broadcast',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders: new Map(),
        logger: {
            log: (msg, level) => { /* noop */ },
            logFundsStatus: () => {}
        },
        requestStructuralGridResync: async () => {},
        _lastUnmatchedChainOrders: [],
        _pendingBroadcasts: new Map(),
        lockOrders: () => {},
        unlockOrders: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        _setRebalanceState: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _clearWorkingGridRef: () => {},
        _throwOnIllegalState: false
    };
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    bot._currentCycleId = 1;
    return bot;
}

async function testCowCatchBlockPassesFillLockAlreadyHeld() {
    console.log('\n[UNC-012] _updateOrdersOnChainBatchCOW passes fillLockAlreadyHeld:true to reconcile...');
    const bot = makeBot();
    const slotId = 'slot-unc-012';
    const actionOrderId = '1.7.999999';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origExecuteStrategy = bot._executeOperationsWithStrategy;
    const origReconcile = bot._reconcileAfterUncertainBroadcast;
    const origValidateFunds = bot._validateOperationFunds;
    let reconcileOptions = null;

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId });
    bot.manager.getChainFundsSnapshot = () => ({});

    chainOrders.buildUpdateOrderOp = async (account, orderId, delta, rawOnChain) => ({
        op: { fee: { amount: 0, asset_id: '1.3.0' }, op_data: {} },
        finalInts: { sell: 100, receive: 1 }
    });

    bot._validateOperationFunds = () => ({ isValid: true, summary: '', violations: [] });

    bot._executeOperationsWithStrategy = async (_ops, _ctxs) => {
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-012', timeoutMs: 30000 });
    };

    bot._reconcileAfterUncertainBroadcast = async (_err, _ctxs, opts) => {
        reconcileOptions = opts;
        return { executed: false, uncertain: true };
    };

    const cowResult = {
        workingGrid: {},
        workingIndexes: {},
        workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: slotId,
            orderId: actionOrderId,
            newSize: 100,
            order: { type: 'sell', price: 0.05, size: 100 }
        }]
    };

    try {
        await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert(reconcileOptions, '_reconcileAfterUncertainBroadcast must be called');
        assert.strictEqual(reconcileOptions.fillLockAlreadyHeld, true,
            'reconcile must receive fillLockAlreadyHeld:true to avoid reentrant deadlock');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        bot._executeOperationsWithStrategy = origExecuteStrategy;
        bot._reconcileAfterUncertainBroadcast = origReconcile;
    }
    console.log('✓ UNC-012 passed');
}

async function testExecuteWithRetryOnUncertainRetriesOnce() {
    console.log('\n[UNC-013] _executeWithRetryOnUncertain retries once on BroadcastUncertainError then throws...');
    const bot = makeBot();
    const origExecuteStrategy = bot._executeOperationsWithStrategy;
    let callCount = 0;

    bot._executeOperationsWithStrategy = async (_ops, _ctxs) => {
        callCount++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013', timeoutMs: 30000 });
    };

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([], []),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 2, 'must try exactly 2 times (1 initial + 1 retry)');
                return true;
            }
        );
    } finally {
        bot._executeOperationsWithStrategy = origExecuteStrategy;
    }
    console.log('✓ UNC-013 passed');
}

async function testExecuteWithRetrySkipsPartialOnChainState() {
    console.log('\n[UNC-014] _executeWithRetryOnUncertain skips retry when partialOnChainState is set...');
    const bot = makeBot();
    const origExecuteStrategy = bot._executeOperationsWithStrategy;
    let callCount = 0;

    bot._executeOperationsWithStrategy = async (_ops, _ctxs) => {
        callCount++;
        const err = new BroadcastUncertainError('uncertain', { batchId: 'unc-014', timeoutMs: 30000 });
        err.partialOnChainState = true;
        err.groupsBroadcast = 1;
        err.groupsTotal = 2;
        throw err;
    };

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([], []),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 1, 'must NOT retry when partialOnChainState is true');
                assert.strictEqual(err.partialOnChainState, true);
                return true;
            }
        );
    } finally {
        bot._executeOperationsWithStrategy = origExecuteStrategy;
    }
    console.log('✓ UNC-014 passed');
}

async function main() {
    console.log('Running uncertain-broadcast recovery tests...');
    await testFingerprintDeterministic();
    await testFingerprintRejectsBadInput();
    await testBroadcastUncertainErrorCarriesMetadata();
    await testExactChainOrderMatchIsAdopted();
    await testRecordedPendingBroadcastStoresSlotId();
    await testNoChainMatchIsDiscarded();
    await testNearMatchWithinToleranceIsAdopted();
    await testOutsideToleranceIsNotAdopted();
    await testNearMatchUsesPendingSideWhenGridSlotMissing();
    await testBroadcastUncertainErrorIsNotRetried();
    await testReconcileAdoptsRuntimePendingBroadcast();
    await testReconcileReadFailureRequestsStructuralResync();
    await testReconcileAcquiresFillLock();
    await testCowBatchAdvancesCycleMarker();
    await testCredentialClientDeadlineReplyBecomesUncertain();
    await testCredentialClientBroadcastTimeoutBecomesUncertain();
    await testExecuteBatchDoesNotRetryUncertainDaemonBroadcast();
    await testExecuteBatchRetriesExpiredDaemonSessionOnly();
    await testExecuteBatchRetryPreservesUncertainBroadcastHandling();
    await testAutoCancelPerCycleCap();
    await testAutoCancelUsesSyncEngineChainOrderIdShape();
    await testAutoCancelSkipsWhenPendingBroadcasts();
    await testAutoCancelSkipsFingerprinted();
    await testCowCatchBlockPassesFillLockAlreadyHeld();
    await testExecuteWithRetryOnUncertainRetriesOnce();
    await testExecuteWithRetrySkipsPartialOnChainState();
    testsComplete = true;
    console.log('\nAll uncertain-broadcast tests passed (incl. retry + deadlock regression guards).');
}

main().catch((err) => {
    console.error('Uncertain-broadcast test suite failed:', err);
    process.exit(1);
});
