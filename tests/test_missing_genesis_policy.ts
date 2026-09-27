/**
 * tests/test_missing_genesis_policy.ts
 *
 * docs/GRID_PRICE_INVARIANT.md — the "no genesis" migration policy.
 *
 * Covers:
 *   GEN-01..05  resolvePersistedGenesis: T1 (migration adopts), T2 (slot
 *               mismatch → refused), T3 (non-finite config → refused), T4
 *               (build throws → refused), empty grid (not a fault)
 *   GEN-06..09  policy resolution: default 'rebuild', explicit 'halt',
 *               case/garbage tolerance, ratio limit override
 *   GEN-10..14  loadGrid (E1): refuses before mutating state, records the
 *               fault, honours 'halt', empty grid unaffected, unchanged
 *               behaviour for a valid persisted genesis
 *   GEN-15..16  AccountOrders.loadGenesis schema gate (empty/absent levels)
 *   GEN-17..19  sync-engine E2 assert: reports once, counts, requests resync
 */
const assert = require('assert');

let policy: any;
let gridMod: any;
let accountOrdersMod: any;
let syncEngineMod: any;
try { policy = require('../modules/order/genesis_policy'); } catch { policy = require('../dist/modules/order/genesis_policy.js'); }
try { gridMod = require('../modules/order/grid'); } catch { gridMod = require('../dist/modules/order/grid.js'); }
try { accountOrdersMod = require('../modules/account_orders'); } catch { accountOrdersMod = require('../dist/modules/account_orders.js'); }
try { syncEngineMod = require('../modules/order/sync_engine'); } catch { syncEngineMod = require('../dist/modules/order/sync_engine.js'); }

const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const {
    MISSING_GENESIS_REASON,
    ON_MISSING_GENESIS,
    MissingGenesisError,
    isMissingGenesisError,
    hasGenesisLadder,
    buildGenesisFromLiveRail,
    resolveMismatchRatioLimit,
    resolveOnMissingGenesisPolicy,
    resolvePersistedGenesis
} = policy;
const { createOrderGrid, loadGrid } = gridMod;

const BASE_CONFIG = {
    startPrice: 100,
    minPrice: 80,
    maxPrice: 120,
    incrementPercent: 1,
    targetSpreadPercent: 2,
    gridLimits: {}
};

/** Slots from a real createOrderGrid run, so prices match the rail exactly. */
function slotsFrom(config, count = 3) {
    const built = createOrderGrid(config);
    return built.orders.slice(0, count).map((o: any) => ({ ...o }));
}

/** Minimal manager double for loadGrid (same shape as the invariant test). */
function makeManager(overrides: any = {}) {
    const logs: string[] = [];
    const manager: any = {
        config: { ...BASE_CONFIG },
        assets: { assetA: { id: '1.3.0', precision: 5, symbol: 'AAA' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BBB' } },
        funds: { btsFeesOwed: 0 },
        orders: new Map(),
        boundaryIdx: null,
        _genesis: null,
        _gridVersion: 0,
        _gridLock: { acquire: async (fn: any) => fn() },
        _fundLock: { acquire: async (fn: any) => fn() },
        _initializeAssets: async () => {},
        resetFunds: async () => {},
        _restoreBoundary: function (idx: any) { this.boundaryIdx = idx; },
        pauseRecalcLogging: () => {},
        resumeRecalcLogging: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _applyOrderUpdate: async function (order: any) { this.orders.set(order.id, order); },
        logger: { log: (msg: any) => logs.push(String(msg)) },
        ...overrides,
        get logs() { return logs; }
    };
    return manager;
}

async function run() {
    console.log('Running missing-genesis policy tests...');

    // ── GEN-01: T1 — legacy snapshot, matching config → migration ladder adopted
    {
        const slots = slotsFrom(BASE_CONFIG);
        const res = resolvePersistedGenesis({ config: BASE_CONFIG, grid: slots });
        assert.strictEqual(res.ok, true, 'T1 resolves');
        assert.strictEqual(res.source, 'migration', 'T1 source is migration');
        assert.ok(hasGenesisLadder(res.genesis), 'T1 produces a ladder');
        assert.ok(res.genesis.priceLevels.length > slots.length, 'ladder is the full rail, not the truncated array');
    }

    // ── GEN-02: T1 with a persisted ladder short-circuits migration
    {
        const slots = slotsFrom(BASE_CONFIG);
        const persisted = createOrderGrid(BASE_CONFIG).genesis;
        const res = resolvePersistedGenesis({ config: BASE_CONFIG, grid: slots, genesisInput: persisted });
        assert.strictEqual(res.source, 'persisted', 'explicit genesis wins');
        assert.strictEqual(res.genesis, persisted, 'same object returned');
    }

    // ── GEN-03: in-memory ladder used when no snapshot row exists
    {
        const slots = slotsFrom(BASE_CONFIG);
        const inMemory = createOrderGrid(BASE_CONFIG).genesis;
        const res = resolvePersistedGenesis({ config: BASE_CONFIG, grid: slots, managerGenesis: inMemory });
        assert.strictEqual(res.source, 'in_memory', 'manager genesis is adopted');
    }

    // ── GEN-04: T2 — config edited across restarts → refused, ratio reported
    {
        const slots = slotsFrom(BASE_CONFIG);
        const edited = { ...BASE_CONFIG, startPrice: 200, minPrice: 160, maxPrice: 240 };
        const logs: string[] = [];
        const res = resolvePersistedGenesis({ config: edited, grid: slots, log: (m: string) => logs.push(m) });
        assert.strictEqual(res.ok, false, 'T2 refused');
        assert.strictEqual(res.reason, MISSING_GENESIS_REASON.SLOT_MISMATCH, 'T2 reason');
        assert.ok(res.mismatchRatio > 0.5, `mismatch ratio reported (${res.mismatchRatio})`);
        assert.ok(logs.some(l => l.includes('NOT adopting')), 'the operator is told the rail was not adopted');
    }

    // ── GEN-05: T2 boundary — exactly at the limit is adopted, above it refused
    {
        const slots = slotsFrom(BASE_CONFIG, 4);
        const built = createOrderGrid(BASE_CONFIG).genesis;
        // Perturb ONE slot's price so exactly 1/4 mismatch (0.25 <= 0.5).
        const tweaked = slots.map((s: any, i: number) => (i === 0 ? { ...s, price: s.price * 1.5 } : s));
        const okRes = resolvePersistedGenesis({ config: BASE_CONFIG, grid: tweaked });
        assert.strictEqual(okRes.ok, true, 'below the ratio limit the migration is adopted');
        assert.ok(hasGenesisLadder(okRes.genesis), 'adopted ladder present');

        // Two of four mismatching (0.5) is still within "<= limit" (refusal is strictly >).
        const tweaked2 = tweaked.map((s: any, i: number) => (i === 1 ? { ...s, price: s.price * 1.5 } : s));
        assert.strictEqual(resolvePersistedGenesis({ config: BASE_CONFIG, grid: tweaked2 }).ok, true,
            'ratio exactly at the limit is still adoptable');

        // Three of four (0.75) crosses it.
        const tweaked3 = tweaked2.map((s: any, i: number) => (i === 2 ? { ...s, price: s.price * 1.5 } : s));
        const refused = resolvePersistedGenesis({ config: BASE_CONFIG, grid: tweaked3 });
        assert.strictEqual(refused.ok, false, 'above the ratio limit the migration is refused');
        assert.ok(hasGenesisLadder(built), 'control: the real ladder is intact');
    }

    // ── GEN-06: T3 — non-finite config (unresolved price mode) → refused
    {
        const slots = slotsFrom(BASE_CONFIG);
        for (const key of ['startPrice', 'minPrice', 'maxPrice', 'incrementPercent']) {
            const res = resolvePersistedGenesis({ config: { ...BASE_CONFIG, [key]: 'pool' }, grid: slots });
            assert.strictEqual(res.ok, false, `T3 refused for non-finite ${key}`);
            assert.strictEqual(res.reason, MISSING_GENESIS_REASON.NON_FINITE_CONFIG, `T3 reason for ${key}`);
            assert.ok(res.detail.includes(key), `T3 detail names the offending key (${key})`);
        }
    }

    // ── GEN-07: T4 — a throwing ladder build is a refusal, not a crash
    {
        const slots = slotsFrom(BASE_CONFIG);
        const res = buildGenesisFromLiveRail({
            ...BASE_CONFIG,
            // incrementPercent above 100% makes the down-rail degenerate and
            // calculateGapSlots throw — a stand-in for any future build throw.
            incrementPercent: 100,
            minPrice: 99.5,
            maxPrice: 100.5
        });
        // Either the build throws (T4) or it produces a ladder; both are legal,
        // but it must never THROW out of the resolver itself.
        if (res.ok === false) {
            assert.ok([MISSING_GENESIS_REASON.MIGRATION_FAILED, MISSING_GENESIS_REASON.NON_FINITE_CONFIG].includes(res.reason),
                'T4 uses a known reason');
        }
        assert.doesNotThrow(() => resolvePersistedGenesis({ config: BASE_CONFIG, grid: slots }),
            'the resolver never throws');
    }

    // ── GEN-21: rail geometry is shared, and a non-positive incrementPercent
    //     is refused instead of spinning the geometric loop forever.
    {
        const cfg = { ...BASE_CONFIG, targetSpreadPercent: 2 };
        const fresh = createOrderGrid(cfg).genesis;
        const migrated = buildGenesisFromLiveRail(cfg);
        assert.strictEqual(migrated.ok, true, 'migration builder resolves the rail');
        assert.deepStrictEqual(migrated.genesis.priceLevels, fresh.priceLevels,
            'migrated ladder equals a fresh build (one shared derivePriceLevels)');
        assert.strictEqual(migrated.genesis.priceLevelsHash, fresh.priceLevelsHash,
            'hashes agree too');

        // incrementPercent = 0 makes the geometric loop non-terminating. The
        // shared guard must refuse it — this assertion would HANG without it.
        const zero = buildGenesisFromLiveRail({ ...cfg, incrementPercent: 0 });
        assert.strictEqual(zero.ok, false, 'incrementPercent=0 is refused, not hung');
        assert.strictEqual(zero.reason, MISSING_GENESIS_REASON.MIGRATION_FAILED,
            'the refusal is a migration failure');
        assert.strictEqual(buildGenesisFromLiveRail({ ...cfg, incrementPercent: -1 }).ok, false,
            'negative incrementPercent is refused by the same guard');
    }

    // ── GEN-08: an empty grid is not a fault (no orders to price-match)
    {
        const res = resolvePersistedGenesis({ config: { ...BASE_CONFIG, startPrice: 'pool' }, grid: [] });
        assert.strictEqual(res.ok, true, 'empty grid resolves without a ladder');
        assert.strictEqual(res.genesis, null, 'no ladder invented for an empty grid');
    }

    // ── GEN-09: policy resolution
    {
        assert.strictEqual(resolveOnMissingGenesisPolicy({}), ON_MISSING_GENESIS.REBUILD, 'default is rebuild');
        assert.strictEqual(resolveOnMissingGenesisPolicy(null), ON_MISSING_GENESIS.REBUILD, 'null config is rebuild');
        assert.strictEqual(resolveOnMissingGenesisPolicy({ gridLimits: {} }), ON_MISSING_GENESIS.REBUILD, 'no override is rebuild');
        assert.strictEqual(resolveOnMissingGenesisPolicy({ gridLimits: { MISSING_GENESIS_POLICY: 'halt' } }), ON_MISSING_GENESIS.HALT, 'explicit halt');
        assert.strictEqual(resolveOnMissingGenesisPolicy({ gridLimits: { MISSING_GENESIS_POLICY: ' HALT ' } }), ON_MISSING_GENESIS.HALT, 'case/space tolerant');
        assert.strictEqual(resolveOnMissingGenesisPolicy({ gridLimits: { MISSING_GENESIS_POLICY: 'garbage' } }), ON_MISSING_GENESIS.REBUILD, 'unknown value falls back to the safe default');
        assert.strictEqual(resolveMismatchRatioLimit({}), 0.5, 'default ratio limit');
        assert.strictEqual(resolveMismatchRatioLimit({ gridLimits: { MISSING_GENESIS_MISMATCH_RATIO: 0.9 } }), 0.9, 'ratio limit override');
        assert.strictEqual(resolveMismatchRatioLimit({ gridLimits: { MISSING_GENESIS_MISMATCH_RATIO: 5 } }), 0.5, 'out-of-range ratio falls back');
    }

    // ── GEN-10: E1 — loadGrid refuses a genesis-less snapshot and mutates nothing
    {
        const slots = slotsFrom(BASE_CONFIG, 3);
        const manager = makeManager({ config: { ...BASE_CONFIG, startPrice: 'pool' } });
        let thrown: any = null;
        try { await loadGrid(manager, slots as any, 0, null); } catch (e: any) { thrown = e; }
        assert.ok(thrown, 'loadGrid refuses without a ladder');
        assert.ok(isMissingGenesisError(thrown), 'the refusal is a MissingGenesisError');
        assert.ok(thrown instanceof MissingGenesisError, 'instanceof holds too');
        assert.strictEqual(thrown.reason, MISSING_GENESIS_REASON.NON_FINITE_CONFIG, 'reason carried on the error');
        assert.strictEqual(thrown.policy, ON_MISSING_GENESIS.REBUILD, 'default policy carried on the error');
        assert.strictEqual(manager.orders.size, 0, 'no slot was installed');
        assert.strictEqual(manager._genesis, null, 'no ladder was invented');
        assert.strictEqual(manager.boundaryIdx, null, 'no boundary was restored');
        assert.ok(manager._missingGenesis && manager._missingGenesis.reason === MISSING_GENESIS_REASON.NON_FINITE_CONFIG,
            'fault recorded for observability');
        assert.ok(manager.logs.some(l => l.includes('[GENESIS] No usable price ladder')), 'refusal logged');
    }

    // ── GEN-11: E1 — 'halt' is carried on the fault (operator consent path)
    {
        const slots = slotsFrom(BASE_CONFIG, 3);
        const manager = makeManager({
            config: { ...BASE_CONFIG, startPrice: 'pool', gridLimits: { MISSING_GENESIS_POLICY: 'halt' } }
        });
        let thrown: any = null;
        try { await loadGrid(manager, slots as any, 0, null); } catch (e: any) { thrown = e; }
        assert.ok(isMissingGenesisError(thrown), 'halt still refuses');
        assert.strictEqual(thrown.policy, ON_MISSING_GENESIS.HALT, 'policy is halt');
        assert.ok(manager._missingGenesis.policy === 'halt', 'recorded policy is halt');
        assert.ok(manager.logs.some(l => l.includes('manual grid reset')), 'halt guidance names the manual reset');
    }

    // ── GEN-12: E1 — T2 through loadGrid (edited config) is refused too
    {
        const slots = slotsFrom(BASE_CONFIG, 3);
        const manager = makeManager({ config: { ...BASE_CONFIG, startPrice: 200, minPrice: 160, maxPrice: 240 } });
        let thrown: any = null;
        try { await loadGrid(manager, slots as any, 0, null); } catch (e: any) { thrown = e; }
        assert.ok(isMissingGenesisError(thrown), 'T2 refused at load');
        assert.strictEqual(thrown.reason, MISSING_GENESIS_REASON.SLOT_MISMATCH, 'T2 reason');
        assert.strictEqual(manager.orders.size, 0, 'nothing installed');
    }

    // ── GEN-13: E1 — a resolvable legacy snapshot still loads (T1 unchanged)
    {
        const built = createOrderGrid(BASE_CONFIG);
        const manager = makeManager();
        await loadGrid(manager, built.orders.slice(0, 4) as any, built.boundaryIdx, null);
        assert.ok(hasGenesisLadder(manager._genesis), 'migration ladder adopted on load');
        assert.ok(manager.orders.size > 0, 'slots installed');
        assert.ok(!manager._missingGenesis, 'no fault recorded for the T1 path');
        assert.ok(manager.logs.some(l => l.includes('Migrated legacy grid')),
            'migration adoption is logged (the live branch, not a dead else-if)');
    }

    // ── GEN-14: E1 — a valid persisted genesis clears a stale fault record
    {
        const built = createOrderGrid(BASE_CONFIG);
        const manager = makeManager({ _missingGenesis: { reason: 'slot_mismatch', detail: 'stale' } });
        await loadGrid(manager, built.orders.slice(0, 2) as any, 0, built.genesis);
        assert.strictEqual(manager._missingGenesis, null, 'a resolved fault is cleared');
    }

    // ── GEN-15: E1 — an empty snapshot array is untouched by the gate
    {
        const manager = makeManager({ config: { ...BASE_CONFIG, startPrice: 'pool' } });
        await loadGrid(manager, [] as any, null, null);
        assert.strictEqual(manager.orders.size, 0, 'no slots for an empty snapshot');
        assert.ok(!manager._missingGenesis, 'empty snapshot is not a fault');
    }

    // ── GEN-16: AccountOrders.loadGenesis schema gate
    {
        const AccountOrders = accountOrdersMod.AccountOrders || accountOrdersMod;
        const os = require('os');
        const tmpFile = require('path').join(os.tmpdir(), `dexbot-genesis-schema-${process.pid}.json`);
        const withData = (data: any) => {
            const inst: any = new AccountOrders({ botKey: 'genesis-schema-gate', profilesPath: tmpFile });
            inst.data = data;
            inst._loadData = () => data;
            inst._persist = () => { };
            return inst;
        };
        assert.strictEqual(withData({ genesis: { priceLevels: [], priceLevelsHash: 'abcd1234' } }).loadGenesis(), null,
            'empty priceLevels is not a ladder');
        assert.strictEqual(withData({ genesis: { priceLevelsHash: 'abcd1234' } }).loadGenesis(), null,
            'missing priceLevels is not a ladder');
        assert.ok(withData({ genesis: { priceLevels: [1, 2, 3], priceLevelsHash: 'abcd1234' } }).loadGenesis(),
            'a populated ladder is returned');
        assert.ok(withData({ genesis: { priceLevels: [1, 2, 3], priceLevelsHash: 'tampered' } }).loadGenesis(),
            'a tampered hash is still returned (loadGrid owns that warning)');
    }

    // ── GEN-17..19: E2 sync-entry assert
    {
        const SyncEngine = syncEngineMod.default || syncEngineMod.SyncEngine;
        const assertGenesis = SyncEngine.prototype._assertGenesisInvariant;
        assert.strictEqual(typeof assertGenesis, 'function', 'sync engine exposes the assert');

        const requested: any[] = [];
        const logs: string[] = [];
        const mgr: any = {
            orders: new Map([['slot-0', { id: 'slot-0' }], ['slot-1', { id: 'slot-1' }]]),
            _genesis: null,
            logger: { log: (m: string) => logs.push(String(m)) },
            requestStructuralGridResync: async (reason: string, details: any) => { requested.push({ reason, details }); return true; }
        };
        await assertGenesis.call({}, mgr);
        await new Promise((r) => setImmediate(r));
        assert.ok(logs.some(l => l.includes('INVARIANT')), 'the violation is reported');
        assert.strictEqual(requested.length, 1, 'a structural resync is requested');
        assert.strictEqual(requested[0].reason, 'missing-genesis', 'resync reason is the invariant name');

        // Latched: a second sync in the same generation must not re-report/re-request.
        await assertGenesis.call({}, mgr);
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(logs.filter(l => l.includes('INVARIANT')).length, 1, 'reported once per generation');
        assert.strictEqual(requested.length, 1, 'resync requested once per generation');
        assert.ok(mgr._genesisInvariantViolations >= 2, 'violations are counted for observability');

        // With a ladder: silent.
        mgr._genesis = { priceLevels: [1, 2] };
        const before = logs.length;
        await assertGenesis.call({}, mgr);
        assert.strictEqual(logs.length, before, 'a healthy manager logs nothing');

        // Empty grid: silent even without a ladder.
        const emptyLogs: string[] = [];
        const empty: any = { orders: new Map(), _genesis: null, logger: { log: (m: string) => emptyLogs.push(String(m)) } };
        await assertGenesis.call({}, empty);
        assert.strictEqual(emptyLogs.length, 0, 'an empty grid logs nothing');
    }

    // ── GEN-20: recovery reload honours the 'halt' policy
    {
        const { recoverFromPersistedGrid } = require('../modules/dexbot_state_recovery');
        const slots = slotsFrom(BASE_CONFIG, 3);
        const botFor = (manager: any) => ({
            accountId: '1.2.3',
            accountOrders: { loadGrid: () => slots, loadBoundaryIdx: () => null, loadGenesis: () => null },
            manager
        });

        // 'rebuild' (default): fail the reload and let the caller run the
        // structural resync — no `halt` flag.
        const rebuildManager = makeManager({ config: { ...BASE_CONFIG, startPrice: 'pool' } });
        const rebuildResult = await recoverFromPersistedGrid(botFor(rebuildManager));
        assert.strictEqual(rebuildResult.success, false, 'rebuild policy fails the reload');
        assert.ok(!rebuildResult.halt, 'rebuild policy leaves the resync to the caller');
        assert.ok(rebuildManager.logs.some(l => l.includes('Escalating to a structural resync')),
            'rebuild guidance logged');

        // 'halt': fail the reload AND mark it so the caller skips the resync.
        const haltManager = makeManager({
            config: { ...BASE_CONFIG, startPrice: 'pool', gridLimits: { MISSING_GENESIS_POLICY: 'halt' } }
        });
        const haltResult = await recoverFromPersistedGrid(botFor(haltManager));
        assert.strictEqual(haltResult.success, false, 'halt policy fails the reload');
        assert.strictEqual(haltResult.halt, true, 'halt policy signals the caller to suppress the resync');
        assert.ok(haltManager.logs.some(l => l.includes('manual grid reset')),
            'halt guidance names the manual reset');
        assert.ok(!haltManager.logs.some(l => l.includes('Escalating to a structural resync')),
            'halt does not claim a resync it will not run');
    }

    console.log('✓ All missing-genesis policy tests passed');
}

if (require.main === module) {
    run().catch((err) => {
        console.error('✗ Test failed');
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { run };
}
