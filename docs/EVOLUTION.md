# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 1.0.13 stable release.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 1,713+ commits over ~7 active months
- **Code Maturity**: Evolution from basic utilities to a ~58,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 200+ automated test files
- **Releases**: 46 release entries (v0.1.0 to v1.0.13)

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

**Jun 12–16 — First stable release v1.0.0**:
- Profile validation, logging overhaul (write queue/rotation/JSON), AMA delta threshold, on-chain authority resolution.
- Credential hardening (8 finding groups), centralization of project-root/fs/math/magic-number utilities, error-path hardening (silent-catch elimination).
- Post-release: docker context, root bypass, keep-alive recovery, phantom LP cleanup, chain client reconnect, headless unlock mode, Credit/MPA Claw bridge, test auto-discovery.
- New subsystems: shared-account fund registry with cross-bot invariants, credit/MPA collateral proportional allocation, settings merge consolidation, vendored uPlot, node config editor.

**Jun 17**: Fund registry fixes (canonical bot keys in whitelist, `this` context restoration in collapsed runtime); DEXBot comparison doc refresh.

**Jun 18–19 — Browser compatibility core**:
- Six portable abstractions: `StorageAdapter`, `CryptoProvider`, `Config`, `PATHS`, `ProcessDiscovery`, `KeyStore`; `env.ts` environment detection, `Runtime` singleton, `path_api.ts`.
- Pure-JS crypto fallbacks (`pure_scrypt`, `pure_ripemd160`, `pure_secp256k1`), `ecc.browser.ts`, `ecc_selector.ts`, in-memory `StorageAdapter`, lazy `ws`/`pm2` loading.
- 140+ files refactored to route through portable abstractions; 1288-line test suite; browser-safe surface complete.

**Jun 20–21 — Credit runtime & I/O centralization**:
- Credit runtime hardening (multi-asset collateral `assetId` wrapping, stale reborrow `renewOnly` bypass fix).
- Full I/O pipeline centralization through `StorageAdapter` (15 newly browser-safe modules, 28-check bundle verification).
- Shared `sleep()`/`writeJsonFileAtomic` utilities across 21 files; final browser-compat gaps closed (`base58check.ts` Buffer-free, `ecc.ts`/`paths.ts` env routing, serial/signing marked node-only).

**Jun 22**: Browser-safe surface enforcement (lazy require wrappers, storage adapter path fix); credit runtime `disallowedDealIds` filter (1.22.x compat), `ratio`→`outputWeight` rename with shim; 15-file doc sweep.

**Jun 25**: DAEMON_ERRORS retry-path fix (session-expiry retry never fired — hardcoded mismatch with canonical constants). Canonical error-code hardening via `DAEMON_CODES` and `MasterPasswordError.code`, replacing 12+ literal sites.

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
- **Phase 6: Stable Release (v1.0.0)**: Production stability with a full browser-safe core. Consolidated logging (write queue, rotation, JSON), startup profile validation, final TS strict-mode, on-chain authority resolution, credential security hardening (8 finding groups), centralized project-root/fs/math utilities, and silent-catch elimination. Browser compatibility shipped via portable abstractions and pure-JS crypto with bundle verification; credit runtime and I/O pipeline centralization completed. (See Phase 5 timeline above for topic detail.)

---

## Version History

Compact view; per-commit detail lives in [CHANGELOG.md](../CHANGELOG.md).

| Release | Commits | Theme |
|---------|--------:|-------|
| v0.1.0 → v0.2.0 | 29 | Core order/fund management, docs, tooling |
| v0.2.0 → v0.3.0 | 155 | Fund mgmt & BTS fees, grid divergence, persistence, race conditions |
| v0.3.0 → v0.4.0 | 18 | Fund consolidation, grid sizing/quantization, partial orders |
| v0.4.0 → v0.5.0 | 92 | AsyncLock race prevention, fill dedup, dust recovery, spread correction |
| v0.5.0 → v0.6.0 | 598 | COW architecture, strategy/sync engine, credential daemon, AMA prototype |
| v0.6.0 → v0.7.0 | 325 | AMA market adapter, credit/MPA debt runtime, analysis suite |
| v0.7.0 → v0.7.4 | 12 | AMA/Kalman stability, Docker launcher, docs refresh |
| v0.7.4 → v0.7.5 | 93 | Zero-dependency & TS migration, native BitShares, fill detection overhaul |
| v0.7.5 → v0.7.8 | 18 | Unlock/launcher hardening, background daemon, MPA `debtOnly` |
| v0.7.8 → v0.7.11 | 33 | Runtime self-healing, COW integrity, foreign-daemon defense, CLI polish |
| v0.7.11 → v0.7.15 | 31 | CLI/terminal polish, TradingView, CEX seeding, pipeline hardening |
| v0.7.15 → v0.7.18 | 19 | Build/dir centralization, `@ts-nocheck` removal, timeout hardening, DRY |
| v0.7.18 → v1.0.0 | 103 | First stable: profile validation, logging, credential security, browser compat |
| v1.0.0 → v1.0.4 | 15 | Auto-update hardening, candle gap repair, update-script fixes |
| v1.0.4 → v1.0.7 | 13 | Grid "one order per price" invariant, subscription watchdog, broadcast deadlock fix |
| v1.0.7 → v1.0.9 | 9 | Pending-broadcast deadlock, log dedup, trade PnL analysis tool |
| v1.0.9 → v1.0.11 | 20 | PnL metrics overhaul, live `bots.json`, BitShares market fee model |
| v1.0.11 → v1.0.13 | 17 | Whitelist normalization, grid persistence safety net, dust pipeline fix, net inventory lots |

---

## Development Statistics

200+ automated test files (all TypeScript), 46 release entries. See **Version History** for commit breakdown by release.

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

## Post-1.0.0: Completed

- **Dependency Reduction**: Zero-dependency runtime via `tsx`, all external runtime dependencies removed (v0.7.5)
- **Performance Analytics — PnL Tracking**: `analysis/trade_profitability.ts` — Kibana-driven FIFO/Sequential PnL with 16 metrics (July 2026, v1.0.9+)

## Post-1.0.0: Planned

- **Web & Terminal UI**: Browser-based and TUI dashboards for monitoring and tuning
- **Backtesting Engine**: Replay historical candles through `OrderManager`/COW via a `MemoryExchange` drop-in at the `bitshares_client` boundary
- **Performance Analytics — Remaining**: Grid efficiency metrics and HTML report generation
- **Monorepo Split**: Package into `@dexbot/core`, `@dexbot/bitshares`, `@dexbot/indicators` for parallelized builds
- **Injectable Module Interfaces**: Dependency inversion at call boundaries for testability (no event bus)
- **Database (SQLite) + Zod Validation**: Replace JSON persistence, validate blockchain objects at the client boundary

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: July 11, 2026 (v1.0.13)
**Total Commits**: 1,713
**Date Range**: December 2, 2025 - July 11, 2026 (ongoing)
**Repository**: DEXBot2 (BitShares DEX Trading Bot)
