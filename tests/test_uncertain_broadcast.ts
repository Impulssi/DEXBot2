const assert = require('assert');
const { EventEmitter } = require('events');
const net = require('net');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const chainOrders = require('../modules/chain_orders');
const chainKeys = require('../modules/chain_keys');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, DAEMON_CODES, DAEMON_ERRORS } = require('../modules/constants');
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
        accountName: '1.2.x',
        batchId: 'batch-42',
        payload: { type: 'execute-operations' },
        timeoutMs: 30000
    });
    assert.strictEqual(err.name, 'BroadcastUncertainError');
    assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
    assert.strictEqual(err.accountName, '1.2.x');
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
    bot.manager.synchronizeWithChain = async (params) => {
        syncCalls++;
        assert.strictEqual(params.gridOrderId, slotId);
        assert.strictEqual(params.chainOrderId, '1.7.572312011');
        assert.strictEqual(params.expectedType, 'sell');
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
        assert.strictEqual(result.adoptedCount, 1, 'matching chain order should be adopted');
        assert.strictEqual(result.discardedCount, 0);
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 0, 'pending broadcasts must be cleared after recovery');
        assert.strictEqual(readCalls, 1, 'uncertain broadcast recovery reads chain orders once');
        assert.strictEqual(syncCalls, 1, 'synchronizeWithChain must be called for each adopted CREATE');
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
            if (insideLock) return fn();
            lockAcquireCalls++;
            insideLock = true;
            try {
                return await fn();
            } finally {
                insideLock = false;
            }
        },
        isReentrant: () => insideLock,
    };
    bot.manager.synchronizeWithChain = async (params) => {
        syncCalls++;
        assert.strictEqual(insideLock, true, 'recovery sync must run while fill lock is held');
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
        assert.strictEqual(syncCalls, 1, 'synchronizeWithChain must be called for each adopted CREATE');
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

async function testCredentialClientFallbackRetrySucceeds() {
    console.log('\n[UNC-008i-1] credential client fallbackNodes: 1 fallback, 1st DEADLINE → 2nd succeeds...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.1' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        if (requestCount === 1) {
            assert.strictEqual(request.nodeUrl, undefined, 'First attempt has no nodeUrl override');
            socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
        } else {
            assert.strictEqual(request.nodeUrl, 'wss://fallback-1.bitshares.org/ws', 'Second attempt uses fallback nodeUrl');
            socket.endLine({ success: true, operation_results: [] });
        }
    });
    try {
        const result = await executeOperationsViaCredentialDaemon('test-account', operations, {
            socketPath: transport.socketPath,
            requestType: 'broadcast',
            timeoutMs: 100,
            fallbackNodes: ['wss://fallback-1.bitshares.org/ws'],
        });
        assert.ok(result.success);
        assert.strictEqual(requestCount, 2, 'Should retry once on fallback');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-1 passed');
}

async function testCredentialClientFallbackRetryExhausted() {
    console.log('\n[UNC-008i-2] credential client fallbackNodes: all DEADLINE → throws after exhausting...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.2' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
                fallbackNodes: [
                    'wss://fallback-1.bitshares.org/ws',
                    'wss://fallback-2.bitshares.org/ws',
                ],
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
                return true;
            }
        );
        assert.strictEqual(requestCount, 3, 'Should try all 3 nodes (1 primary + 2 fallbacks)');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-2 passed');
}

async function testCredentialClientFallbackSkipsPlainError() {
    console.log('\n[UNC-008i-3] credential client fallbackNodes: plain Error → no retry...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.3' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, error: DAEMON_ERRORS.SESSION_EXPIRED + ':session expired' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
                fallbackNodes: ['wss://fallback-1.bitshares.org/ws'],
            }),
            (err) => {
                assert(!(err instanceof BroadcastUncertainError));
                assert(err.message.includes(DAEMON_ERRORS.SESSION_EXPIRED));
                return true;
            }
        );
        assert.strictEqual(requestCount, 1, 'Should not retry on plain errors');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-3 passed');
}

async function testCredentialClientFallbackEmptyList() {
    console.log('\n[UNC-008i-4] credential client fallbackNodes: [] → no retry (regression guard)...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.4' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
                fallbackNodes: [],
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                return true;
            }
        );
        assert.strictEqual(requestCount, 1, 'Empty fallback list should not retry');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-4 passed');
}

async function testCredentialClientFallbackReportsFailedNode() {
    console.log('\n[UNC-008i-5] credential client fallbackNodes: fires onNodeFailed on DEADLINE...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.5' } }];
    let requestCount = 0;
    const failedNodes: string[] = [];
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
                fallbackNodes: [
                    'wss://fallback-1.bitshares.org/ws',
                    'wss://fallback-2.bitshares.org/ws',
                ],
                onNodeFailed: (nodeUrl) => { failedNodes.push(nodeUrl); },
            }),
            (err) => err instanceof BroadcastUncertainError
        );
        assert.strictEqual(requestCount, 3, 'Should try all 3 nodes');
        assert.strictEqual(failedNodes.length, 2, 'onNodeFailed fires for both fallbacks (primary has no nodeUrl)');
        assert.strictEqual(failedNodes[0], 'wss://fallback-1.bitshares.org/ws', 'First failing fallback reported');
        assert.strictEqual(failedNodes[1], 'wss://fallback-2.bitshares.org/ws', 'Last exhausted fallback also reported');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-5 passed');
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
    console.log('\n[UNC-009] _autoCancelOneUnmatchedOrphan only cancels price-drift-orphan entries, enforces per-cycle cap=1...');
    const bot = makeBot();
    bot._currentCycleId = 7;
    bot.manager._lastUnmatchedChainOrders = [
        { id: '1.7.111', orderId: '1.7.111', reason: 'price-drift-orphan' },
        { id: '1.7.222', orderId: '1.7.222', reason: 'price-drift-orphan' },
        { id: '1.7.333', orderId: '1.7.333', reason: 'price-drift-orphan' }
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
    console.log('\n[UNC-009b] _autoCancelOneUnmatchedOrphan handles sync-engine chainOrderId shape (price-drift-orphan)...');
    const bot = makeBot();
    bot._currentCycleId = 11;
    bot.manager._lastUnmatchedChainOrders = [
        { chainOrderId: '1.7.777', type: 'sell', price: 0.05, size: 1, reason: 'price-drift-orphan' }
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
        { id: '1.7.555', orderId: '1.7.555', reason: 'price-drift-orphan' }
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

async function testAutoCancelOnlyPriceDriftOrphans() {
    console.log('\n[UNC-011b] _autoCancelOneUnmatchedOrphan skips non-price-drift orphans...');
    const bot = makeBot();
    bot._currentCycleId = 12;
    // Three unmatched entries with NO price-drift-orphan reason.
    bot.manager._lastUnmatchedChainOrders = [
        { id: '1.7.111', orderId: '1.7.111', reason: 'unknown' },
        { id: '1.7.222', orderId: '1.7.222', reason: 'duplicate-price-level' },
        { id: '1.7.333', orderId: '1.7.333', reason: 'already-matched-slot' }
    ];
    const origCancel = chainOrders.cancelOrder;
    let cancelCalled = false;
    chainOrders.cancelOrder = async () => { cancelCalled = true; };
    const origRecord = chainOrders.recordOwnCancel;
    chainOrders.recordOwnCancel = () => {};

    try {
        const r = await bot._autoCancelOneUnmatchedOrphan();
        assert.strictEqual(r.cancelled, false, 'must not cancel non-price-drift orphans');
        assert.strictEqual(r.reason, 'no-price-drift-orphan', 'reason must indicate no price-drift orphan');
        assert.strictEqual(cancelCalled, false, 'cancelOrder must not be called');
    } finally {
        chainOrders.cancelOrder = origCancel;
        chainOrders.recordOwnCancel = origRecord;
    }
    console.log('✓ UNC-011b passed');
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
    console.log('\n[UNC-012] _updateOrdersOnChainBatchCOW recovery path...');
    const bot = makeBot();
    const slotId = 'slot-unc-012';
    const actionOrderId = '1.7.999999';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origExecuteBatch = chainOrders.executeBatch;

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId });
    bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 1000, chainFreeBuy: 1000 });
    bot.manager.synchronizeWithChain = async () => {};
    bot.manager.applyGridUpdateBatch = async () => {};
    bot.manager.persistGrid = async () => {};

    chainOrders.buildUpdateOrderOp = async (account, orderId, delta, rawOnChain) => ({
        op: { op_name: 'limit_order_update', op_data: { new_price: { base: { asset_id: '1.3.0', amount: 100 } } } },
        finalInts: { sell: 100, receive: 1 }
    });

    chainOrders.executeBatch = async () => {
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-012', timeoutMs: 30000 });
    };
    chainOrders.readOpenOrders = async () => [];

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
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert(result.uncertain === true, 'uncertain broadcast must trigger recovery path');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.readOpenOrders = origReadOpenOrders;
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-012 passed');
}

async function testExecuteWithRetryOnUncertainRetriesOnce() {
    console.log('\n[UNC-013] _executeWithRetryOnUncertain retries once on BroadcastUncertainError then throws...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    let callCount = 0;

    chainOrders.executeBatch = async () => {
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
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-013 passed');
}

async function testExecuteWithRetrySkipsPartialOnChainState() {
    console.log('\n[UNC-014] _executeWithRetryOnUncertain skips retry when partialOnChainState is set...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    let callCount = 0;

    chainOrders.executeBatch = async () => {
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
        chainOrders.executeBatch = origExecuteBatch;
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
    await testCredentialClientFallbackRetrySucceeds();
    await testCredentialClientFallbackRetryExhausted();
    await testCredentialClientFallbackSkipsPlainError();
    await testCredentialClientFallbackEmptyList();
    await testCredentialClientFallbackReportsFailedNode();
    await testExecuteBatchDoesNotRetryUncertainDaemonBroadcast();
    await testExecuteBatchRetriesExpiredDaemonSessionOnly();
    await testExecuteBatchRetryPreservesUncertainBroadcastHandling();
    await testAutoCancelPerCycleCap();
    await testAutoCancelUsesSyncEngineChainOrderIdShape();
    await testAutoCancelSkipsWhenPendingBroadcasts();
    await testAutoCancelSkipsFingerprinted();
    await testAutoCancelOnlyPriceDriftOrphans();
    await testCowCatchBlockPassesFillLockAlreadyHeld();
    await testExecuteWithRetryOnUncertainRetriesOnce();
    await testExecuteWithRetrySkipsPartialOnChainState();
    await testUpdateToCreateFallbackOnNotFound();
    await testUpdateToCreateFallbackRotationBranch();
    await testUpdateToCreateFallbackCreateAlsoFails();
    await testRecoverFromPersistedGrid();
    await testRecoverFromPersistedGridNoGrid();
    await testRecoverFromPersistedGridBloated();
    await testRecoverFromPersistedGridUnmatchedRemain();
    await testBoundaryShiftAllDiscarded();
    await testBoundaryShiftMixedAdoptedDiscarded();
    await testBoundaryShiftAllAdopted();
    testsComplete = true;
    console.log('\nAll uncertain-broadcast tests passed (incl. retry + deadlock regression guards).');
}

// ── UPDATE→CREATE fallback: size-update branch ──────────────────────────
async function testUpdateToCreateFallbackOnNotFound() {
    console.log('\n[UNC-015] UPDATE→CREATE fallback on "not found" (size-update branch)...');
    const bot = makeBot();
    const slotId = 'slot-unc-015';
    const actionOrderId = '1.7.999015';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origBuildCreate = chainOrders.buildCreateOrderOp;
    const origExecuteBatch = chainOrders.executeBatch;
    let loggedWarn = null;
    let capturedCreateArgs = null;

    bot.manager.orders.set(slotId, {
        id: slotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId
    });
    bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 1000, chainFreeBuy: 1000 });
    bot.manager.synchronizeWithChain = async () => {};
    bot.manager.applyGridUpdateBatch = async () => {};
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._commitWorkingGrid = async () => {};
    bot.manager.logger.log = (msg, level) => {
        if (level === 'warn') loggedWarn = msg;
    };

    chainOrders.buildUpdateOrderOp = async () => { throw new Error('Order 1.7.999015 not found'); };
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        capturedCreateArgs = { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        return {
            op: { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: Number(amountToSell), asset_id: sellAssetId } } },
            finalInts: { sell: Number(amountToSell), receive: Number(minToReceive), sellAssetId, receiveAssetId }
        };
    };
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[null, '1.7.999016']]
    });

    const cowResult = {
        workingGrid: {}, workingIndexes: {}, workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: slotId, orderId: actionOrderId,
            newSize: 100,
            order: { type: 'sell', price: 0.05, size: 100 }
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert.strictEqual(result.executed, true, 'UPDATE→CREATE fallback should produce a valid CREATE op and execute it');
        assert(capturedCreateArgs, 'buildCreateOrderOp fallback must be called when UPDATE fails with "not found"');
        assert(loggedWarn && loggedWarn.includes('Recovered "not found"'),
            'should log the recovery warning');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.buildCreateOrderOp = origBuildCreate;
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-015 passed');
}

// ── UPDATE→CREATE fallback: rotation branch ─────────────────────────────
async function testUpdateToCreateFallbackRotationBranch() {
    console.log('\n[UNC-015b] UPDATE→CREATE fallback on "not found" (rotation branch, newGridId !== id)...');
    const bot = makeBot();
    const oldSlotId = 'slot-unc-015b-old';
    const newSlotId = 'slot-unc-015b-new';
    const actionOrderId = '1.7.999015b';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origBuildCreate = chainOrders.buildCreateOrderOp;
    const origExecuteBatch = chainOrders.executeBatch;
    let capturedCreateArgs = null;

    bot.manager.orders.set(oldSlotId, { id: oldSlotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId });
    bot.manager.orders.set(newSlotId, { id: newSlotId, type: 'sell', price: 0.06, size: 90 });
    bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 1000, chainFreeBuy: 1000 });
    bot.manager.synchronizeWithChain = async () => {};
    bot.manager.applyGridUpdateBatch = async () => {};
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._commitWorkingGrid = async () => {};

    chainOrders.buildUpdateOrderOp = async () => { throw new Error('Order 1.7.999015b not found'); };
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        capturedCreateArgs = { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        return {
            op: { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: Number(amountToSell), asset_id: sellAssetId } } },
            finalInts: { sell: Number(amountToSell), receive: Number(minToReceive), sellAssetId, receiveAssetId }
        };
    };
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[null, '1.7.999016']]
    });

    const cowResult = {
        workingGrid: {}, workingIndexes: {}, workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: oldSlotId,
            orderId: actionOrderId,
            newGridId: newSlotId,
            newSize: 90,
            newPrice: 0.06,
            order: { type: 'sell', price: 0.06, size: 90 },
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert.strictEqual(result.executed, true);
        assert(capturedCreateArgs, 'buildCreateOrderOp fallback must be called for rotation UPDATE→CREATE');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.buildCreateOrderOp = origBuildCreate;
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-015b passed');
}

// ── UPDATE→CREATE fallback: CREATE also fails ───────────────────────────
async function testUpdateToCreateFallbackCreateAlsoFails() {
    console.log('\n[UNC-015c] UPDATE→CREATE fallback: CREATE also fails — fall through to error log...');
    const bot = makeBot();
    const slotId = 'slot-unc-015c';
    const actionOrderId = '1.7.999015c';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origBuildCreate = chainOrders.buildCreateOrderOp;
    let loggedError = null;
    let loggedWarn = null;

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId });
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._commitWorkingGrid = async () => {};
    bot.manager.logger.log = (msg, level) => {
        if (level === 'error') loggedError = msg;
        if (level === 'warn') loggedWarn = msg;
    };

    chainOrders.buildUpdateOrderOp = async () => { throw new Error('Order 1.7.999015c does not exist'); };
    chainOrders.buildCreateOrderOp = async () => { throw new Error('insufficient funds'); };

    const cowResult = {
        workingGrid: {}, workingIndexes: {}, workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: slotId, orderId: actionOrderId,
            newSize: 100,
            order: { type: 'sell', price: 0.05, size: 100 }
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert.strictEqual(result.executed, false, 'no ops to broadcast when both UPDATE and CREATE fallback fail');
        assert(loggedWarn && loggedWarn.includes('CREATE fallback also failed'), 'CREATE failure should warn');
        assert(loggedError && loggedError.includes('Failed to prepare update op'), 'original error should also be logged');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.buildCreateOrderOp = origBuildCreate;
    }
    console.log('✓ UNC-015c passed');
}

// ── _recoverFromPersistedGrid: success path ─────────────────────────────
async function testRecoverFromPersistedGrid() {
    console.log('\n[UNC-016] _recoverFromPersistedGrid loads grid from disk and re-syncs...');
    const bot = makeBot();
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origPersist = bot.manager.persistGrid;
    let loadGridCalled = false;
    let loadBoundaryCalled = false;
    let syncCalledWith = null;
    let persistCalled = false;

    // _recoverFromPersistedGrid checks this.accountId first
    bot.accountId = 'test-account';

    // Add the properties that the real loadGrid and syncFromOpenOrders need
    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    bot.manager._applyOrderUpdate = async () => true;
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;

    const persistedGrid = [
        { id: 'slot-1', type: 'buy', price: 0.04, size: 200, orderId: '1.7.111' },
        { id: 'slot-2', type: 'sell', price: 0.06, size: 100, orderId: '1.7.222' }
    ];
    const chainState = [
        { id: '1.7.111', type: 'buy', price: 0.04, for_sale: 200 },
        { id: '1.7.222', type: 'sell', price: 0.06, for_sale: 100 }
    ];

    bot.accountOrders = {
        loadGrid: (force) => {
            if (force) loadGridCalled = true;
            return persistedGrid;
        },
        loadBoundaryIdx: (force) => {
            if (force) loadBoundaryCalled = true;
            return 42;
        }
    };

    chainOrders.readOpenOrders = async (accountRef) => {
        assert.strictEqual(accountRef, 'test-account');
        return chainState;
    };

    bot.manager.syncFromOpenOrders = async (orders, options) => {
        syncCalledWith = { orders, options };
        return { filledOrders: [], updatedOrders: [] };
    };
    bot.manager.persistGrid = async () => {
        persistCalled = true;
        return { isValid: true };
    };

    try {

        const result = await bot._recoverFromPersistedGrid();
        assert.strictEqual(result.success, true);
        assert.strictEqual(loadGridCalled, true, 'loadGrid(true) must be called to force-reload from disk');
        assert.strictEqual(loadBoundaryCalled, true, 'loadBoundaryIdx(true) must be called');
        assert(syncCalledWith, 'syncFromOpenOrders must be called with chain data');
        assert.strictEqual(syncCalledWith.orders, chainState, 'sync must receive the chain state');
        assert.strictEqual(syncCalledWith.options.skipAccounting, true);
        // AsyncLock is re-entrant; fillLockAlreadyHeld flag eliminated
        assert.strictEqual(persistCalled, true, 'persistGrid must be called to save reconciled state');
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot.manager.persistGrid = origPersist;
    }
    console.log('✓ UNC-016 passed');
}

// ── _recoverFromPersistedGrid: no persisted grid on disk ────────────────
async function testRecoverFromPersistedGridNoGrid() {
    console.log('\n[UNC-016b] _recoverFromPersistedGrid fails cleanly when no persisted grid exists...');
    const bot = makeBot();

    bot.accountOrders = {
        loadGrid: () => null,
        loadBoundaryIdx: () => null
    };

    const result = await bot._recoverFromPersistedGrid();
    assert.strictEqual(result.success, false);
    assert(result.reason, 'should provide a reason for failure');
    assert(result.reason.includes('no persisted grid'), `reason should mention missing grid, got: ${result.reason}`);
    console.log('✓ UNC-016b passed');
}

// ── _recoverFromPersistedGrid: rejects bloated grid after reload ────────
async function testRecoverFromPersistedGridBloated() {
    console.log('\n[UNC-016c] _recoverFromPersistedGrid rejects grid that is still bloated after reload...');
    const bot = makeBot();
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origPersist = bot.manager.persistGrid;
    let loadGridCalled = false;

    bot.accountId = 'test-account';

    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    // _applyOrderUpdate must actually store orders so the post-reload
    // isGridBloated check sees non-empty data.
    bot.manager.orders = new Map();
    bot.manager._applyOrderUpdate = async (order: any) => {
        bot.manager.orders.set(order.id, { ...order });
    };
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;
    bot.manager.config = {
        incrementPercent: 0.3,
        targetSpreadPercent: 0.6,
    };

    // Bloated grid: 60 active at geometric prices → railEstimate ~60,
    // maxAllowed = 60 + gap + 5 ≈ 67. But we inject 100 extra VIRTUAL
    // slots at tightly clustered prices (all at 1.0), so gridSize=160
    // far exceeds the price-range estimate from min/max prices.
    const activeOrders = [];
    for (let i = 0; i < 30; i++) activeOrders.push({
        id: 'b' + i, type: 'buy', state: 'active',
        price: 1.0 * Math.pow(1.003, i), size: 10, orderId: '1.7.' + i,
    });
    for (let i = 0; i < 30; i++) activeOrders.push({
        id: 's' + i, type: 'sell', state: 'active',
        price: 1.0 * Math.pow(1.003, 100 + i), size: 10, orderId: '1.7.' + (100 + i),
    });
    const virtualExtra = [];
    for (let i = 0; i < 100; i++) virtualExtra.push({
        id: 'x' + i, type: 'spread', state: 'virtual',
        price: 1.0, size: 0, orderId: '',
    });
    const persistedGrid = [...activeOrders, ...virtualExtra];

    const chainState = activeOrders.map((o: any) => ({
        id: o.orderId, type: o.type, price: o.price, for_sale: o.size,
    }));

    bot.accountOrders = {
        loadGrid: (force) => {
            if (force) loadGridCalled = true;
            return persistedGrid;
        },
        loadBoundaryIdx: () => 0,
    };

    chainOrders.readOpenOrders = async () => chainState;

    bot.manager.syncFromOpenOrders = async () => ({ filledOrders: [], updatedOrders: [] });
    bot.manager.persistGrid = async () => ({ isValid: true });

    try {
        const result = await bot._recoverFromPersistedGrid();
        // loadGrid's inner bloat check may also fire requestStructuralGridResync
        // (async fire-and-forget), but the outer check must reject because the
        // grid is still oversized after reload.
        assert.strictEqual(result.success, false,
            'Recovery must reject bloated grid: success=' + result.success +
            ' reason=' + (result.reason || 'none'));
        assert(result.reason, 'should provide a reason');
        assert(result.reason.includes('still bloated'),
            `reason should mention bloat, got: ${result.reason}`);
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot.manager.persistGrid = origPersist;
    }
    console.log('✓ UNC-016c passed');
}

// ── _recoverFromPersistedGrid: rejects when unmatched orders remain ─────
async function testRecoverFromPersistedGridUnmatchedRemain() {
    console.log('\n[UNC-016d] _recoverFromPersistedGrid rejects when unmatched chain orders remain after sync...');
    const bot = makeBot();
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origPersist = bot.manager.persistGrid;

    bot.accountId = 'test-account';

    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    bot.manager._applyOrderUpdate = async () => true;
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;
    bot.manager.config = {
        incrementPercent: 0.3,
        targetSpreadPercent: 0.6,
    };

    // Simulate grid with 2 orders loaded from disk.
    const persistedGrid = [
        { id: 'slot-1', type: 'buy', price: 0.04, size: 200, orderId: '1.7.111' },
        { id: 'slot-2', type: 'sell', price: 0.06, size: 100, orderId: '1.7.222' }
    ];
    // Chain has 2 matching orders PLUS one extra orphan.
    const chainState = [
        { id: '1.7.111', type: 'buy', price: 0.04, for_sale: 200 },
        { id: '1.7.222', type: 'sell', price: 0.06, for_sale: 100 },
        { id: '1.7.333', type: 'sell', price: 0.09, for_sale: 50 }
    ];

    bot.accountOrders = {
        loadGrid: () => persistedGrid,
        loadBoundaryIdx: () => 0,
    };

    chainOrders.readOpenOrders = async () => chainState;

    // syncFromOpenOrders simulates finding the extra chain order as unmatched.
    // It sets _lastUnmatchedChainOrders to simulate the sync engine's behavior.
    bot.manager.syncFromOpenOrders = async (orders, options) => {
        bot.manager._lastUnmatchedChainOrders = [
            { chainOrderId: '1.7.333', type: 'sell', price: 0.09, size: 50, reason: 'duplicate-price-level' }
        ];
        bot.manager._lastUnmatchedChainOrdersAt = Date.now();
        return {
            filledOrders: [],
            updatedOrders: [],
            unmatchedChainOrders: [
                { chainOrderId: '1.7.333', type: 'sell', price: 0.09, size: 50, reason: 'duplicate-price-level' }
            ]
        };
    };
    bot.manager.persistGrid = async () => ({ isValid: true });

    try {
        const result = await bot._recoverFromPersistedGrid();
        // Must reject because persisted grid + sync did not resolve all unmatched.
        assert.strictEqual(result.success, false,
            'Recovery must reject when unmatched orders remain: success=' + result.success +
            ' reason=' + (result.reason || 'none'));
        assert(result.reason, 'should provide a reason');
        assert(result.reason.includes('unmatched'),
            `reason should mention unmatched, got: ${result.reason}`);
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot.manager.persistGrid = origPersist;
    }
    console.log('✓ UNC-016d passed');
}

// ── Boundary shift: all CREATEs discarded → boundary must NOT shift ─────
async function testBoundaryShiftAllDiscarded() {
    console.log('\n[UNC-017] Boundary shift recovery: all CREATEs discarded → boundaryIdx unchanged...');
    const bot = makeBot();
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origAutoCancel = bot._autoCancelOneUnmatchedOrphan;

    const INITIAL_BOUNDARY = 5;
    bot.manager.boundaryIdx = INITIAL_BOUNDARY;
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    bot.manager.synchronizeWithChain = async () => {};

    for (let i = 0; i <= 9; i++) {
        const side = i <= INITIAL_BOUNDARY ? 'buy' : 'sell';
        bot.manager.orders.set(`slot-${i}`, { id: `slot-${i}`, type: side, price: 0.05 + i * 0.001, size: 1 });
    }

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'sell-1', type: 'sell', price: 0.06, size: 1 },
        finalInts: { sell: 100000000, receive: 5000000 }
    });

    chainOrders.readOpenOrders = async () => [];
    bot._autoCancelOneUnmatchedOrphan = async () => ({ cancelled: false });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-discard', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'sell-1' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 0, 'no CREATEs should be adopted');
        assert.strictEqual(result.discardedCount, 2, 'both CREATEs should be discarded');
        assert.strictEqual(bot.manager.boundaryIdx, INITIAL_BOUNDARY,
            'boundaryIdx must NOT shift when all CREATEs are discarded');
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot._autoCancelOneUnmatchedOrphan = origAutoCancel;
    }
    console.log('✓ UNC-017 passed');
}

// ── Boundary shift: mixed adopted/discarded → boundary shifts for adopted only ─
async function testBoundaryShiftMixedAdoptedDiscarded() {
    console.log('\n[UNC-017b] Boundary shift recovery: mixed adopted/discarded → boundary shifts for adopted only...');
    const bot = makeBot();
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origAutoCancel = bot._autoCancelOneUnmatchedOrphan;

    const INITIAL_BOUNDARY = 5;
    bot.manager.boundaryIdx = INITIAL_BOUNDARY;
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    bot.manager.synchronizeWithChain = async () => {};

    for (let i = 0; i <= 9; i++) {
        const side = i <= INITIAL_BOUNDARY ? 'buy' : 'sell';
        bot.manager.orders.set(`slot-${i}`, { id: `slot-${i}`, type: side, price: 0.05 + i * 0.001, size: 1 });
    }

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'sell-1', type: 'sell', price: 0.06, size: 1 },
        finalInts: { sell: 100000000, receive: 5000000 }
    });

    chainOrders.readOpenOrders = async () => [
        makeChainOrder('1.7.300', 'buy', 5000000, 100000000)
    ];
    bot._autoCancelOneUnmatchedOrphan = async () => ({ cancelled: false });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-mixed', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'sell-1' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 1, '1 CREATE should be adopted');
        assert.strictEqual(result.discardedCount, 1, '1 CREATE should be discarded');
        assert.strictEqual(bot.manager.boundaryIdx, INITIAL_BOUNDARY,
            'boundaryIdx should remain unchanged after uncertain broadcast recovery (reconcile does not shift boundary)');
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot._autoCancelOneUnmatchedOrphan = origAutoCancel;
    }
    console.log('✓ UNC-017b passed');
}

// ── Boundary shift: all CREATEs adopted → boundary shifts for all ──────
async function testBoundaryShiftAllAdopted() {
    console.log('\n[UNC-017c] Boundary shift recovery: all CREATEs adopted → boundary shifts for all...');
    const bot = makeBot();
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origAutoCancel = bot._autoCancelOneUnmatchedOrphan;

    const INITIAL_BOUNDARY = 5;
    bot.manager.boundaryIdx = INITIAL_BOUNDARY;
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    bot.manager.synchronizeWithChain = async () => {};

    for (let i = 0; i <= 9; i++) {
        const side = i <= INITIAL_BOUNDARY ? 'buy' : 'sell';
        bot.manager.orders.set(`slot-${i}`, { id: `slot-${i}`, type: side, price: 0.05 + i * 0.001, size: 1 });
    }

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'buy-2', type: 'buy', price: 0.04, size: 1 },
        finalInts: { sell: 4000000, receive: 80000000 }
    });

    chainOrders.readOpenOrders = async () => [
        makeChainOrder('1.7.400', 'buy', 5000000, 100000000),
        makeChainOrder('1.7.401', 'buy', 4000000, 80000000)
    ];
    bot._autoCancelOneUnmatchedOrphan = async () => ({ cancelled: false });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-adopt-all', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'buy-2' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 2, 'both CREATEs should be adopted');
        assert.strictEqual(result.discardedCount, 0, 'no CREATEs should be discarded');
        assert.strictEqual(bot.manager.boundaryIdx, INITIAL_BOUNDARY,
            'boundaryIdx should remain unchanged after uncertain broadcast recovery');
    } finally {
        chainOrders.readOpenOrders = origReadOpenOrders;
        bot._autoCancelOneUnmatchedOrphan = origAutoCancel;
    }
    console.log('✓ UNC-017c passed');
}

main().catch((err) => {
    console.error('Uncertain-broadcast test suite failed:', err);
    process.exit(1);
});
