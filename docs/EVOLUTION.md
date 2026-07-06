# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 1.0.9 stable release.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 1,670+ commits over ~7 active months
- **Code Maturity**: Evolution from basic utilities to a ~58,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 200+ automated test files
- **Releases**: 44 release entries (v0.1.0 to v1.0.9)

---

## Pre-History: Generational Lineage

DEXBot2 is the third generation of BitShares DEX trading bot development, preceded by two Python-based projects. See [DEXBOT_COMPARISON.md](DEXBOT_COMPARISON.md) for a full architectural comparison.

### Generation 0: StakeMachine (2017)
Proof-of-concept by Fabian Schuh (ChainSquad GmbH). Static buy/sell walls with event-driven subscription model.

### Generation 1: DEXBot Python v1.0.0 (2018–2020)
Production bot by Codaone Oy (worker proposal funded). PyQt5 GUI, three strategies (Staggered Orders, Relative Orders, King of the Hill), CCXT/CoinGecko feeds, SQLite persistence.

**Carried into DEXBot2**: Staggered grid concept, virtual/off-chain order tracking, market center price calculation.

---

## Timeline Overview

### Phase 1: Foundation & Core Architecture (December 2025)
Started Dec 2 with a JavaScript rewrite from the Python DEXBot. Built core trading infrastructure (BitShares client, grid calculation system, fund accounting, order management) and released v0.1.0–v0.3.0 within the first month, establishing the modular architecture, PARTIAL order state, and PM2 process management that underpin the entire project.

### Phase 2: Stabilization & Advanced Features (January 2026)
Added AMA trend detection, blockchain integer-based precision system, comprehensive test suite, ghost order prevention, self-healing recovery layers, and fund-driven boundary sync. Ported the test suite from Jest to native Node.js assert to eliminate heavy dependencies. Resolved 12+ critical race conditions in fill processing.

### Phase 3: Architecture Refinement & COW Pattern (February 2026)
Implemented Copy-on-Write grid architecture with immutable master grid, atomic boundary shifts, and deadlock resolution. Added multi-node health checking, dashboard scaffolding (Rust/ratatui), and spread correction redesign with edge-based strategy.

### Phase 4: Market Adapter & Production Hardening (Late Feb - March 2026)
Consolidated the market adapter with split data sources (Kibana, native API), AMA-derived grid center, fixed-cap fill batching, and credential daemon hardening. Removed cacheFunds tracking in favor of real-time commitment accounting. Expanded the Claw runtime. Released v0.6.0.

---

### Phase 5: Signal Intelligence & Debt Runtime (March – June 2026)
**Mar–Apr**: Derivative signal engine (SMA/MACD/RSI), dynamic-weight system with Kalman confirmation and ATR volatility scaling, Hurst/PE regime detection, credit/debt runtime for MPA borrow/repay and credit offers.

**May**: Market adapter stabilization, AMA warmup rework, credential daemon hardening — v0.7.0. Shared AMA strategy, Kalman stability, adapter consolidation — v0.7.1–v0.7.4. Native BitShares integration (replaced `btsdex`), zero-dependency policy, full TypeScript migration — v0.7.5. Fill detection overhaul, BTS fee via AMM pool, centralized logging. Unlock hardening, background daemon, auto-update, per-bot logs — v0.7.6–v0.7.8.

**Jun 1–3**: Unlock status health, runtime self-healing (structural resync, targeted reconciliation), `node dexbot order` subcommand — v0.7.9–v0.7.10. COW grid-integrity closure, uncertainty-recovery hardening, foreign-daemon defense, CLI polish — v0.7.11.

**Jun 4–9**: CLI polish, terminal color brightening, TradingView orientation, CEX seeding, quiet orderbook candles, whitelist/dynamic-weight hardening — v0.7.12–v0.7.15.

**Jun 10–11**: Pipeline hardening, BUILD_DIR centralization, HMAC recovery, codebase audit — v0.7.16–v0.7.17. All @ts-nocheck removed (67 files annotated), race-condition batch 1, timeout hardening, DRY refactoring — v0.7.18.

**Jun 12–16**: First stable release v1.0.0 — profile validation, logging overhaul, AMA delta threshold, on-chain authority resolution, credential hardening, centralization of project-root/fs/math/magic-number utilities, error-path hardening. Post-release: docker context, root bypass, keep-alive recovery, phantom LP cleanup, chain client reconnect, headless unlock mode, Credit/MPA Claw bridge, credit runtime fixes, test auto-discovery. New: shared-account fund registry with cross-bot invariants, credit/MPA collateral proportional allocation, settings merge consolidation, uPlot vendored as local library, node config editor, audit log cleanup.

**Jun 17**: Fund registry fixes (canonical bot keys in whitelist, `this` context restoration in collapsed runtime), DEXBot comparison doc refresh.

**Jun 18–19**: Browser compatibility — six portable abstractions (`StorageAdapter`, `CryptoProvider`, `Config`, `PATHS`, `ProcessDiscovery`, `KeyStore`), `env.ts` environment detection, `Runtime` singleton, `path_api.ts`, pure-JS crypto fallbacks (`pure_scrypt`, `pure_ripemd160`, `pure_secp256k1`), `ecc.browser.ts` (pure-JS ECC), `ecc_selector.ts`, browser `StorageAdapter` (in-memory Map), lazy `require('ws')`/`require('pm2')`, browser bundle verification script, comprehensive 1288-line browser abstraction test suite. All 140+ existing files refactored to route through portable abstractions — browser-safe surface complete. Remaining browser-compat gaps closed.

**Jun 20–21**: Credit runtime hardening (multi-asset collateral `assetId` wrapping, stale pending reborrow `renewOnly` bypass fix). Full I/O pipeline centralization through `StorageAdapter` with 15 newly browser-safe modules and 28-check bundle verification. Runtime path consolidation and shared `sleep()`/`writeJsonFileAtomic` utilities across 21 files. Final browser-compat gaps closed — `base58check.ts` Buffer-free, `ecc.ts` crypto routing, `paths.ts` env detection, serial/signing pipeline marked node-only.

**Jun 22**: Browser-safe surface enforcement completed with lazy require wrappers and storage adapter path fix. Credit runtime extended with `disallowedDealIds` filter for 1.22.x BitShares compatibility and `ratio`→`outputWeight` rename with backward-compat shim. Doc sweep across 15 files.

**Jun 25**: DAEMON_ERRORS retry-path fix — `DaemonKeyStore` session-expiry retry never fired due to locally-hardcoded mismatch with canonical constants. Canonical error-code hardening — `DAEMON_CODES` added to `constants.ts` for `BROADCAST_DEADLINE`/`CREDENTIAL_DAEMON_UNAVAILABLE`, `MasterPasswordError.code` static property, replacing 12+ literal sites with single-source-of-truth references.

**Jul 1–3**: v1.0.7 (hotfix) — subscription health watchdog, BROADCAST_DEADLINE graceful recovery (deadlock fix, bot-level retry, configurable daemon attempts) — 2 commits from v1.0.6.

**Jul 5**: v1.0.8 — secondary pending-broadcasts deadlock fix (missed call site), market adapter log dedup in shared runtime, bot key resolution utilities, candle cache always-resolve. Comprehensive system invariants doc expansion with categorized prefixes (`INV-COW`, `INV-SYNC`, `INV-MAINT`, `INV-GRID`, `INV-RECON`, `INV-BATCH`, `INV-REG`, `INV-SUB`). 5 commits from v1.0.7.

---

## Architecture Evolution

DEXBot2's architecture transitioned from monolithic utilities to a decoupled, event-driven, immutable state system:
- **Phase 1-2**: Loose modules for order/account management, basic grid trading.
- **Phase 3-4**: Copy-on-Write grid with atomic modifications, Market Adapter decoupling signals from execution.
- **Phase 5**: Multi-layered runtime — COW core execution, signal pipeline (AMA/Kalman/regime), credit/debt MPA runtime, credit maintenance hardening, credential daemon.
- **Post-5: Zero-Dependency & TypeScript Migration**: Full codebase migration from JavaScript to TypeScript with strict mode, `tsc` build pipeline, zero-dependency runtime via `tsx`, and explicit architectural policy removing all external runtime dependencies.
- **Post-5.1: Fill Detection Overhaul**: Native BitShares fill detection rewrite — direct-notice dispatch, instance-based cursor, subscription reconnect, btsFeeState hardening
- **Post-5.2: Runtime Self-Healing**: Chain-truth reconciliation for shortfalls and drift, structural resync signaling, order-batch fill guarding.
- **Phase 6: Stable Release (v1.0.0)**: Logging system overhaul with write queue, rotation, and JSON output. Startup profile validation. Final TS strict-mode completion. On-chain authority resolution. Credential security hardening across 8 finding groups. Centralization of project-root resolution, fs/math utilities, and magic numbers with regression fixing. Error-path hardening eliminating all silent catches. Comprehensive doc sweep. Browser compatibility: portable abstractions, pure-JS crypto, complete browser-safe surface with bundle verification. Credit runtime hardening. I/O pipeline centralization. The project reaches production stability with full browser-safe core.

---

## Version History

### v0.1.0 → v0.2.0 (29 commits)
Core order/fund management, documentation, scripts & tooling.

### v0.2.0 → v0.3.0 (155 commits)
Fund management & BTS fees, grid divergence detection, persistence & race conditions, order rotation & sizing, refactoring.

### v0.3.0 → v0.4.0 (18 commits)
Fund management consolidation, grid sizing & quantization, market fees & RMS threshold, partial order handling.

### v0.4.0 → v0.5.0 (92 commits)
Critical bug fixes, race condition prevention (AsyncLock), fund management centralization, spread correction, fill processing & deduplication, grid health & dust recovery.

### v0.5.0 → v0.6.0 (598 commits)
Fund accounting overhaul, COW architecture, strategy engine refactoring, sync engine improvements, fill processing hardening, credential daemon, dashboard scaffolding, AMA prototype, comprehensive documentation and testing.

### v0.6.0 → v0.7.0 (325 commits)
AMA-based market adapter with signal pipeline, credential daemon hardening, connection resilience, credit/MPA debt runtime, safer grid lifecycle, expanded analysis suite.

### v0.7.0 → v0.7.1 (2 commits)
Share AMA strategy with market adapter, version history docs.

### v0.7.1 → v0.7.2 (2 commits)
Dynamic-weight Kalman stability patch, chart slope floor adjustment.

### v0.7.2 → v0.7.3 (3 commits)
Docker launcher docs alignment, centralized AMA slope conversion helpers.

### v0.7.3 → v0.7.4 (5 commits)
Code cleanup (unused deps, inline helper), documentation refresh.

### v0.7.4 → v0.7.5 (93 commits)
Zero-dependency and TypeScript migration, native BitShares integration replacing `btsdex`, fill detection overhaul, centralized logging, credential daemon security hardening.

### v0.7.5 → v0.7.6 (5 commits)
Unlock-start launcher hardening (signal handler cleanup, polling guards), deprecated legacy migration code removal, broken reference fixes, 14-file documentation sweep.

### v0.7.6 → v0.7.7 (6 commits)
Default background daemon + crash restart for unlock, auto-update for monolithic path, per-bot log files with daemon output redirect, MPA `debtOnly` flag with discriminated-union types, CLI simplification.

### v0.7.7 → v0.7.8 (7 commits)
Rename `unlock-start` → `unlock`, unify launcher startup/control summaries, harden monolithic restart after auto-update, clean stale build artifacts, add Performance & Speed section to DEXBot comparison doc.

### v0.7.8 → v0.7.9 (9 commits)
Enhance unlock status with market adapter and credential daemon health indicators, fix unlock update lifecycle to restart all runtime services, remove PM2 reload wrapper, de-emphasize PM2 and clarify unlock modes in the README.

### v0.7.9 → v0.7.10 (8 commits)
Runtime self-healing (structural resync, targeted reconciliation, post-reset spread guard), shared sync/fill helper, launcher wrappers without `dist/`, `node dexbot order` subcommand.

### v0.7.10 → v0.7.11 (16 commits)
COW grid-integrity windows closed, uncertainty-recovery hardening, foreign-daemon defense, native transport and watchdog improvements, CLI polish (`clear`, aliases, `status`, dynamic-weight alerts), doc sweep.

### v0.7.11 → v0.7.12 (7 commits)
CLI polish (`default`, `white`/`stat` aliases, `start`→`test`, `restart all`/`stop all`), terminal color brightening, doubled-log lazy-init fix, 20-file doc sweep.

### v0.7.12 → v0.7.13 (9 commits)
TradingView chart pair orientation toggle, CEX synthetic candle seeding, AMA reset and asymmetry default tuning, key manager startup quieting, duplicate build avoidance during update install, masked terminal input editing preservation, active sell color darkening in order display, stale doc reference cleanup.

### v0.7.13 → v0.7.14 (10 commits)
Analyze-orders display overhaul, market-adapter whitelist and dynamic-weight hardening, idempotent unlock startup, simplified runtime controls.

### v0.7.14 → v0.7.15 (5 commits)
Quiet orderbook candle carry-forward for book-sourced market data, plus TTY-safe launcher/updater terminal polish.

### v0.7.15 → v0.7.16 (5 commits)
Pipeline blocking hardening: stale `_gridSidesUpdated` self-blocking fix, dead `anyRotations` removal, redundant fund recalc deduplication, `correctOrderPriceOnChain` finally-block cleanup for all exit paths, dead `_batchRetryInFlight` removal, and throw-safe grid resize guarding. Docs cleanup and whitelist generation simplification.

### v0.7.16 → v0.7.17 (6 commits)
BUILD_DIR centralization, source-mode runtime, HMAC recovery, error hardening, zero-budget shortfall suppression, plus a full codebase audit fixing stale types, dead tests, hardcoded paths, empty dirs, and doc references.

### v0.7.17 → v0.7.18 (8 commits)
Removed all 89 @ts-nocheck directives, added type annotations across 67 files. Race-condition batch 1 (atomic JSON writes, in-flight flags, snapshot persist). Across-the-board timeout hardening and leak fixes. DRY refactoring extracting shared utilities (~460 lines removed).

### v0.7.18 → v1.0.0 (103 commits)
First stable release. Profile validation, logging overhaul, AMA delta threshold, on-chain authority resolution, credential hardening (8 finding groups), centralization of project-root/fs/math/magic-number utilities, error-path hardening, doc sweep. Post-release: headless unlock mode, Credit/MPA Claw bridge, credit runtime fixes, credential daemon hardening, test auto-discovery, settings merge consolidation, shared-account fund registry, credit/MPA collateral proportional allocation, vendored uPlot library, node config editor, analyze-git Chart.js→uPlot migration, fund registry whitelist fixes. Browser compatibility: six portable abstractions (`StorageAdapter`, `CryptoProvider`, `Config`, `PATHS`, `ProcessDiscovery`, `KeyStore`), `env.ts`, `Runtime` singleton, `path_api.ts`, pure-JS crypto fallbacks, `ecc.browser.ts`, `ecc_selector.ts`, lazy `ws`/`pm2` loading, browser bundle verification, 1288-line test suite, 15 newly browser-safe modules, 28-check dist-level verification. Credit runtime multi-asset collateral fixes and stale reborrow guard. I/O pipeline centralization through StorageAdapter. Final browser-compat gaps closed. Browser-safe enforcement, storage adapter path fix, `disallowedDealIds` filter, `outputWeight` rename, doc sweep.

### v1.0.0 → v1.0.1 (4 commits)
Bootstrap fill pipeline refactored to same-side replacement, AccountOrders simplified to one bot per file, deferred maintenance timer guard.

### v1.0.1 → v1.0.2 (4 commits)
Auto-update disabled by default, update script hardened, DAEMON_ERRORS retry-path fix, and canonical error-code hardening via `DAEMON_CODES`/`MasterPasswordError.code` static.

### v1.0.2 → v1.0.3 (5 commits)
Two-step candle gap repair in market adapter (auto-fill ≤24h, then Kibana), market adapter log deduplication, doc version/commit reference refresh.

### v1.0.3 → v1.0.4 (2 commits)
Update script hardening: daemon-downtime-after-update fix (pre-update state snapshot, TTY-gated auto-restart fallback), stash leak elimination (conditional push, apply+drop, auto-resolve with `--theirs`, conflicted `package-lock.json` regeneration). SIGUSR2 monolithic restart fix when `UPDATER.ACTIVE` is false — added local `pendingRestart` flag in `unlock.ts` independent of the updater.

### v1.0.4 → v1.0.5 (1 commit)
Grid invariant enforcement: prevent stale dust duplicates at the same price level. Sync engine rejects orphan adoption when an active order already occupies that price (uses `Math.max(size)` for tight tolerance). Reconcile unconditionally cancels duplicate chain orders on chain. Dust detection expanded to interior partials sharing a price level with an active sibling. Three coordinated layers enforce "one order per grid price level" invariant.

### v1.0.5 → v1.0.6 (6 commits)
Version display in unlock status, partial-fill stale-cache fix, rerun-hint correction, project-root dist-detection centralization via `isDistRuntime()`, and claw `package.json` require path fix.

### v1.0.6 → v1.0.7 (2 commits)
Subscription health watchdog for silent subscription death detection. BROADCAST_DEADLINE graceful recovery: deadlock fix (`fillLockAlreadyHeld:true`), bot-level retry with pair-mode double-publish guard, and configurable daemon broadcast retries (`CREDENTIAL_DAEMON_BROADCAST_RETRIES`).

### v1.0.7 → v1.0.8 (5 commits)
Secondary pending-broadcasts deadlock fix (missed call site). Market adapter log duplication in shared runtime (`stdio: 'ignore'`). Bot key resolution utilities extraction, `roundTo` browser error fix, 20 tests. Remove `--use-cached` flag, always resolve to candle cache. Comprehensive system invariants doc expansion with categorized prefixes across all subsystems.

---



## Development Statistics

200+ automated test files (all TypeScript), 39 release entries. See **Version History** for commit breakdown by release.

---

## Technical Challenges & Solutions

| Challenge | Solution | Impact |
|-----------|----------|--------|
| Race conditions in fill processing | AsyncLock pattern with atomic operations | Eliminated 12+ critical race conditions |
| Float precision in order sizes | Blockchain integer-based calculations (satoshi integers) | Deterministic behavior matching chain storage |
| Ghost orders (tiny remainders in PARTIAL state) | Integer-based full-fill detection | Prevented stuck orders and fund drift |
| Grid corruption during divergence | Copy-on-Write with atomic boundary shifts | Safe concurrent modifications, no data loss |
| BTS fee accounting drift | Unified fee deduction in calculateAvailableFunds | Accurate fee tracking across all operations |
| Rapid-restart cascading failures | Layer 1 & Layer 2 self-healing defenses | Stable restart with automatic recovery |

---

## Documentation & Testing

Evolved from a basic README to a comprehensive framework (50+ docs entries, 80%+ JSDoc coverage, AGENTS.md). Testing matured from manual blockchain trials → Jest → lightweight Node.js assert across a 200+ file suite covering unit, integration, simulation, and COW architectural guard tests.

---

## Conclusion

DEXBot2 has matured from a basic grid bot into a signal-intelligent, production-ready trading system.

---

## Post-1.0.0: Planned

- **Web & Terminal UI**: Browser-based and TUI dashboards for monitoring and tuning
- **Backtesting Engine**: Replay historical candles through `OrderManager`/COW via a `MemoryExchange` drop-in at the `bitshares_client` boundary
- **Performance Analytics**: ✅ PnL tracking (`analysis/trade_profitability.ts`, July 2026); grid efficiency metrics and HTML report generation remain planned
- **Monorepo Split**: Package into `@dexbot/core`, `@dexbot/bitshares`, `@dexbot/indicators` for parallelized builds
- **Injectable Module Interfaces**: Dependency inversion at call boundaries for testability (no event bus)
- **Database (SQLite) + Zod Validation**: Replace JSON persistence, validate blockchain objects at the client boundary
- ~~**Dependency Reduction**~~ ✅ Completed in v0.7.5

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: July 6, 2026 (v1.0.9)
**Total Commits**: 1682
**Date Range**: December 2, 2025 - July 6, 2026 (ongoing)
**Repository**: DEXBot2 (BitShares DEX Trading Bot)
