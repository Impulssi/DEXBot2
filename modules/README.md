# Modules

This is the core runtime of DEXBot2 — the part that actually places orders, tracks fills, and manages the grid on the BitShares blockchain. Entrypoint files (`dexbot.ts`, `unlock.ts`, `pm2.ts` in the repo root) launch and orchestrate what lives here.

Everything below covers bot lifecycle, order management, blockchain connectivity, fill processing, grid maintenance, credential security, and MPA/credit workflows — all the code that isn't an entrypoint, adapter, analysis tool, or bridge.

## Where to Start

If you're new to the codebase, read these files in order (~20 minutes):

1. **`constants.ts`** — all tuning parameters and defaults live here; gives you a map of the system's knobs
2. **`dexbot_class.ts`** — the top-level orchestrator; shows how bot startup, fill processing, and maintenance connect
3. **`order/manager.ts`** — the central controller for the grid; read the constructor and `_applySafeRebalanceCOW()`
4. **`order/grid.ts`** — how the geometric grid is generated and sized

After those four, branch out into `order/accounting.ts` (fund tracking), `order/strategy.ts` (rebalancing logic), and `dexbot_fill_runtime.ts` (fill processing pipeline).

## Layout

```
modules/
├── dexbot_class.ts                bot lifecycle orchestration
├── dexbot_fill_runtime.ts         fill processing pipeline
├── dexbot_maintenance_runtime.ts  sync loops, grid maintenance, triggers
├── bitshares_client.ts            blockchain connection manager
├── node_manager.ts                multi-node health and failover
├── chain_orders.ts                blockchain order operations
├── account_orders.ts              account order queries
├── credit_runtime.ts              MPA/credit deal workflow executor
├── cr_planner.ts                  collateral-ratio planning
├── credential_runtime.ts          credential daemon lifecycle
├── credential_policy.ts           signing policy validation
├── credential_session_cache.ts    encrypted session cache
├── dexbot_credential_client.ts    credential daemon client
├── constants.ts                   central config and tuning params
├── config.ts                      load-time process.env snapshot
├── env.ts                         isBrowser/hasProcess detection
├── runtime.ts                     process abstraction singleton
├── runtime_settings.ts            per-bot runtime settings resolver
├── paths.ts                       guarded path resolution
├── path_api.ts                    portable path abstraction for ESM/browser
├── settings_merge.ts              consolidated settings merge
├── fund_registry.ts               shared-account fund registry
├── authority_resolver.ts          signing key resolution
├── key_store.ts                   key storage (node-only)
├── process_discovery.ts           Linux /proc/* filesystem reads
├── validate_profiles.ts           profile validation
├── general_settings.ts            global settings loader
├── bot_settings.ts                per-bot settings loader
├── logger.ts                      structured logging
├── graceful_shutdown.ts           signal handling and cleanup
├── bots_file_lock.ts              profile write serialization
├── account_bots.ts                bots.json read/write
├── chain_keys.ts                  blockchain key helpers
├── node_health_cache.ts           node health tracking
├── market_adapter_whitelist.ts    adapter whitelist I/O
├── types.ts                       shared type definitions
│
├── crypto/                        cross-environment crypto providers
│   ├── index.ts                   barrel export
│   ├── provider.ts                abstract crypto provider interface
│   ├── browser_provider.ts        Web Crypto based provider
│   ├── node_provider.ts           Node crypto based provider
│   ├── sync.ts                    crypto provider lazy loader
│   ├── pure_ripemd160.ts          pure-JS ripemd160 fallback
│   ├── pure_scrypt.ts             pure-JS scrypt fallback
│   └── pure_secp256k1.ts          pure-JS secp256k1 fallback
│
├── storage/                       portable storage abstraction
│   ├── index.ts                   barrel export
│   ├── types.ts                   storage adapter interface
│   ├── browser_adapter.ts         in-memory Map-based adapter
│   └── node_adapter.ts            fs.*Sync based adapter
│
├── order/                         order lifecycle and grid management
│   ├── manager.ts                 OrderManager — central controller, COW rebalance
│   ├── grid.ts                    grid generation, sizing, health
│   ├── working_grid.ts            COW grid wrapper for safe mutations
│   ├── strategy.ts                grid rebalancing, consolidation, rotation
│   ├── accounting.ts              fund tracking, fee accounting
│   ├── sync_engine.ts             blockchain sync, fill detection, reconciliation
│   ├── grid_reconcile.ts          startup grid reconciliation
│   ├── runner.ts                  order execution runner
│   ├── index.ts                   barrel export
│   ├── logger.ts                  order-scoped logging
│   ├── logger_state.ts            logger state management
│   ├── processed_fill_store.ts    fill deduplication persistence
│   ├── async_lock.ts              async mutex
│   ├── format.ts                  numeric formatting helpers
│   ├── export.ts                  trade history export
│   └── utils/                     math, order predicates, validation, system helpers
│
├── launcher/                      process lifecycle (PM2, unlock, isolated)
│   ├── bot_supervisor.ts          per-bot process supervision
│   ├── child_env.ts               child process environment
│   ├── credential_bootstrap.ts    daemon startup
│   ├── credential_daemon.ts       signing daemon
│   ├── credential_secret.ts       secret management
│   ├── foreign_cred_daemon.ts     external daemon client
│   ├── headless_password.ts       headless password storage
│   ├── launch_modes.ts            monolithic vs isolated routing
│   ├── market_adapter_runtime.ts  adapter process lifecycle
│   ├── market_adapter_watchdog.ts adapter process watchdog
│   ├── monolithic_runtime.ts      monolithic bot runtime
│   ├── runtime_entry.ts           bot process entry
│   ├── status_reporting.ts        process status reporter
│   └── supervisor_control.ts      supervisor orchestration
│
├── bitshares-native/              native blockchain client
│   ├── chain_client.ts            blockchain read API
│   ├── index.ts                   barrel export
│   ├── signing_client.ts          transaction signing
│   ├── transport.ts               WebSocket transport
│   ├── subscriptions.ts           event subscriptions
│   ├── resolvers.ts               operation/object resolvers
│   ├── tx/                        transaction building
│   ├── serial/                    serialization
│   ├── crypto/                    cryptographic primitives
│   └── interfaces.d.ts            type declarations
│
└── utils/
    ├── base58check.ts             Base58Check encoding
    ├── build_dir.ts               BUILD_DIR constant helper
    ├── fs_utils.ts                atomic JSON, read/write, mkdirp
    └── math_utils.ts              re-exports roundTo, fixedTo, roundToDecimals from order/utils/math
```

## Key Relationships

```
dexbot.ts / bot.ts / pm2.ts / unlock.ts  (entrypoints)
    │
    ├── launcher/           process lifecycle, credential daemon
    │
    └── dexbot_class.ts     orchestrates:
         ├── dexbot_fill_runtime.ts        order/ (manager, accounting, grid, sync)
         ├── dexbot_maintenance_runtime.ts order/ (sync engine, grid reconcile)
         ├── credit_runtime.ts             cr_planner.ts
         ├── bitshares_client.ts           node_manager.ts
         │                                  └── bitshares-native/ (chain_client, signing_client)
         └── credential_runtime.ts         credential_policy.ts
```

In plain terms: the **entrypoints** (in the repo root) start processes and hand off to the **launcher**, which boots the credential daemon and bot supervisor. **`dexbot_class.ts`** is the main orchestrator — it wires together the fill runtime (reacts to fills as they happen), the maintenance runtime (periodic sync and grid health checks), and the credit runtime (MPA/debt workflows). The **order subsystem** (`order/`) owns the grid: generating it, syncing it with the blockchain, tracking funds, and rebalancing. The **native client** (`bitshares-native/`) handles all direct blockchain communication so no external trading libraries are needed.

External consumers — other parts of DEXBot2 interact with modules through these touchpoints:

- **`market_adapter/`** — the price adapter reads tuning constants from `constants.ts` and writes trigger files that `dexbot_maintenance_runtime.ts` picks up to decide when to regenerate the grid
- **`claw/`** — the AI bridge layer reads bot profiles and uses the credential client to sign transactions on behalf of the decision loop
- **`analysis/`** — research scripts and operational tools: AMA parameter fitting, trend/volatility/regime charting, bot parameter sweep backtests, bot activity queries, and FIFO-based trade PnL analysis

## Design Principles

- **Zero runtime dependencies** — no npm trading/blockchain libraries; the native client, crypto, and serialization are all in `bitshares-native/`. This eliminates supply-chain risk and keeps the bot fully self-contained.
- **Copy-on-write** — `order/working_grid.ts` provides isolated COW mutations; master grid is immutable during rebalance. The grid is never modified in-place; a working copy is built, mutated, and committed atomically only after blockchain operations succeed.
- **Fund-driven boundary sync** — the grid rebalances based on available funds, not arbitrary triggers; no forced allocations. When a fill arrives, the system calculates what it can actually afford and adjusts the grid around that.
- **Replay-safe accounting** — fill processing in `dexbot_fill_runtime.ts` uses `processed_fill_store.ts` to prevent double-counting. If the bot restarts mid-fill, it can safely replay without creating duplicate orders.
- **Daemon-backed signing** — the credential daemon holds decrypted keys; modules never handle raw private keys. If the main bot crashes, keys stay encrypted on disk — only the small daemon process sees them.
- **Fixed-cap batch processing** — fill batches are capped (default 4) to keep blockchain broadcasts predictable. Even if 20 fills arrive at once, they're processed in small chunks to avoid overwhelming the chain.

## Related

- [Architecture overview](../docs/architecture.md) — high-level system design and data flows
- [Developer guide](../docs/developer_guide.md) — glossary, code reading roadmap, and common tasks
- [Copy-on-write master plan](../docs/COPY_ON_WRITE_MASTER_PLAN.md) — COW grid architecture rationale
- [COW invariants](../docs/COW_INVARIANTS.md) — safety guarantees for grid mutations
- [Fund movement & accounting](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md) — fund tracking algorithms and formulas
- [Credential security](../docs/CREDENTIAL_SECURITY.md) — key handling and daemon-backed signing details
- [Grid recalculation](../docs/GRID_RECALCULATION.md) — when and how the grid resets or regenerates
- [Market adapter](../market_adapter/README.md) — AMA pricing, dynamic weights, and signal pipeline
- [Claw bridge](../claw/README.md) — AI layer integration and command dispatch
