# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 1.4.21 stable release.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 2,024 commits over ~8 active months
- **Code Maturity**: Evolution from basic utilities to a ~70,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 249 automated test files
- **Releases**: 98 release entries (v0.1.0 to v1.4.21)

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
Started Dec 2 with a JavaScript rewrite from the Python DEXBot. Built core trading infrastructure (BitShares client, grid calculation system, fund accounting, order management) and released v0.1.0–v0.3.0 within the first month, establishing the modular architecture, order lifecycle model, and process management that underpin the entire project.

### Phase 2: Stabilization & Advanced Features (January 2026)
Added AMA trend detection, blockchain integer-based precision system, comprehensive test suite, ghost order prevention, self-healing recovery layers, and fund-driven boundary sync. Ported the test suite from Jest to native Node.js assert to eliminate heavy dependencies. Resolved 12+ critical race conditions in fill processing.

### Phase 3: Architecture Refinement & COW Pattern (February 2026)
Implemented Copy-on-Write grid architecture with immutable master grid, atomic boundary shifts, and deadlock resolution. Added multi-node health checking and spread correction redesign with edge-based strategy.

### Phase 4: Market Adapter & Production Hardening (Late Feb - March 2026)
Consolidated the market adapter with split data sources, AMA-derived grid center, fixed-cap fill batching, and credential daemon scaffolding. Replaced cached fund tracking with real-time commitment accounting. Expanded the Claw runtime. Released v0.6.0. This decoupled signal generation from execution — the AMA-derived grid center feeds the order engine as a pure input.

---

### Phase 5: Signal Intelligence, Stable Release & Browser Compatibility (March – June 2026)

The project entered its most transformative phase: a derivative signal engine (dynamic trend-weighting, volatility scaling, regime classification) and a credit/debt MPA runtime were added, the codebase shed all external runtime dependencies while migrating fully to TypeScript, and a security audit of the unlock/daemon stack culminated in the first stable release — v1.0.0 on Jun 16 (profile validation, shared-account fund registry, proportional collateral). A browser-compatibility pass (portable abstractions, pure-JS crypto, storage-adapter I/O) made 140+ files browser-safe. This produced the multi-layered runtime that still shapes the project: COW order core, signal pipeline, credit/debt MPA runtime, and a browser-compatible core.

### Phase 6: Production Hardening & Iterative Refinement (June – July 2026)

Post-stable work focused on reliability: subscription watchdogs, broadcast deadlock recovery at bot and daemon level, and documented system invariants. Iterative releases (v1.0.1–v1.3.3) delivered multi-round AMA refits, oversize credit deal splitting, COW recovery hardening, centralized node-fallback, credit-only mode, and runtime extraction (COW, fill, state recovery) — an incremental-hardening phase that layered new subsystems onto the existing COW core without altering its concurrency model.

### Phase 7: COW Concurrency & Uncertain-Broadcast Hardening (Late July 2026)

After the CJS→ESM migration and strict-mode zero-errors completed the module transition, the v1.4.x releases corrected the COW concurrency model — centralized `withBlockchainRetry` with node failover, a 4-layer duplicate CREATE guard, lock-hierarchy reorder, AsyncLock forceRelease safety, and fund-accounting race hardening — fixing stale COW fund snapshots, phantom-order inflation, and the create-cancel loop. v1.4.8 then closed the uncertain-broadcast and truncated-read ambiguity classes: broadcasts are never blindly re-signed (the credential daemon retries only provably-untransmitted failures), uncertain outcomes surface as typed errors so the COW runtime verifies chain inclusion before re-broadcasting, and truncate-ambiguous `get_full_accounts` reads defer cancel/discard decisions instead of freeing slots or capital for possibly-live orders.

### Phase 8: Native ESM Runtime, Broadcast Serialization & Onboarding (August 2026)

v1.4.12 completed the module transition to native ES modules (root + claw `"type": "module"`, Node >= 22 native WebSocket, dist-first ESM entry shims), removed the remaining legacy-compat shims, and pruned dead code — followed by fixes for the migration's rough edges (Node 22.14 require-cycle boot deadlock, phantom residuals, stranded dust, duplicate-orphan double-cancel). v1.4.13 added a single-flight guard that serializes overlapping COW broadcasts (preventing orphan fills), closed fill-lock bypasses, hardened the no-ALS AsyncLock fallback and ESM packaging gaps, promoted `dexbot start` to the canonical launch command, and added a BitShares onboarding tutorial.

### Phase 9: Post-ESM Cleanup, Consolidation & Hardening (August 2026)

v1.4.16 centralized all user/runtime state onto a single resolver-derived profiles dir (`~/.config/dexbot2/profiles`) so it survives re-clones and npm updates and never lands in a read-only package dir, turned divergence surplus-cancel + hole-create pairs into in-place order rotations, and added an npm auto-update flow. v1.4.17 consolidated duplicate code (EC math, Base58Check, settings merge, asset resolution), trimmed `modules/types.ts` from 875 lines to the Order union, purged dead exports, and centralized the analysis tooling under strict TypeScript. v1.4.19 capped COW broadcasts at `MAX_OPS_PER_BROADCAST` (4) with chunked retry-on-uncertain broadcasting, fixed a spread-collapse regression via the shared `isSlotInRail` helper, lowered the AMA slope grid-reset threshold to 8, and added editor price feedback plus a `docs/LIFECYCLE.md` onboarding walkthrough. v1.4.20 hardened spread-correction boundary promotion with a MIN_SPREAD_ORDERS reserve floor and commit-time validation, gated persisted-boundary restore against self-legalizing overrun poison, aligned dynamic-weight clip parity between the live service and the research chart, centralized chart slider ranges, and moved all analysis outputs onto the central path resolver. v1.4.21 fixed silent-failure runtime defects surfaced by a modules-wide audit (NaN fund-invariant tolerance, always-flush fill store, double-decremented fill guard, config num() defaults), aligned the two boundary writers on a shared sell-rail ceiling enforced at commit and restore time, deduplicated claw shared logic while hardening error paths (secret redaction, EPIPE guards, spawn-error surfacing), corrected launcher supervisor/runtime lifecycle bugs, made the browser storage adapter persist deletions and flush debounced, extended editor green/red live color feedback to funds and price inputs, stopped docs/error messages from hardcoding repo-relative profile paths, and pruned dead code across analysis/market_adapter/claw/logging.

---

## Development Statistics

The project has accumulated 250 automated test files across 98 release entries. See the **Version History** below for a per-release commit breakdown.

---

## Technical Challenges & Solutions

| Challenge | Solution | Impact |
|-----------|----------|--------|
| Race conditions in fill processing | AsyncLock pattern with atomic operations | Eliminated 12+ critical race conditions |
| Float precision in order sizes | Blockchain integer-based calculations (satoshi integers) | Deterministic behavior matching chain storage |
| Ghost orders (tiny remainders from partial fills) | Integer-based full-fill detection | Prevented stuck orders and fund drift |
| Grid corruption during divergence | Copy-on-Write with atomic boundary shifts | Safe concurrent modifications, no data loss |
| BTS fee accounting drift | Unified fee deduction model | Accurate fee tracking across all operations |
| Rapid-restart cascading failures | Layer 1 & Layer 2 self-healing defenses | Stable restart with automatic recovery |

---

## Documentation & Testing

Evolved from a basic README to a comprehensive framework (50+ docs entries, 80%+ JSDoc coverage, AGENTS.md). Testing matured from manual blockchain trials → Jest → lightweight Node.js assert across a 249-file suite covering unit, integration, simulation, and COW architectural guard tests.

---

## Conclusion

DEXBot2 has matured from a basic grid bot into a signal-intelligent, production-ready trading system.

---

## Post-1.0.0: Completed

- **Browser Compatibility**: Portable abstractions, pure-JS crypto, 140+ file refactor for browser-safe surface
- **Credit/MPA Runtime**: Multi-asset collateral support, stale reborrow fixes, oversize deal splitting with per-operation caps
- **I/O Centralization**: Full pipeline routed through storage adapter, shared atomic utilities across 20+ files
- **Self-Healing**: Structural resync, subscription watchdog, broadcast deadlock recovery at both bot and daemon level
- **Performance Analytics**: Kibana-driven FIFO/sequential trade PnL with 16 metrics
- **AMA Refits**: Multi-round parameter optimization with per-market weights and distance scaling
- **System Invariants**: Comprehensive documented invariants across all subsystems (COW, sync, grid, reconciliation)
- **Bot Identity**: Unique name enforcement with migration support
- **Credit-Only Mode**: Runtime-only operation for MPA/credit workflows without grid trading infrastructure
- **Docker Support**: Container build, release images, and secure container startup guidance
- **npm Package**: Published as npm package with versioned releases, lockfile sync, and dependency management
- **Grid Order Engine Hardening**: COW pipeline, zero-amount order prevention, fill batching, dust detection, spread correction, and deadlock recovery

## Post-1.0.0: Planned

- **Backtesting Engine**: Historical candle replay through the trading engine via exchange abstraction
- **Injectable Interfaces**: Dependency inversion at call boundaries for improved testability
- **Database + Validation**: SQLite persistence with Zod schema validation at the blockchain boundary
- **Telegram Bot**: planned but **not yet implemented** — owner-gated monitoring (`/status`, `/orders`, `/grid`, `/balance`) and opt-in+confirm gated control (`/start`, `/stop`, `/pause`); DEXBot is the only writer, private keys never reach the module. Config via a `TELEGRAM` block + `DEXBOT_TELEGRAM_TOKEN` env.

## Version History

Compact, era-level view; per-release commit detail lives in [CHANGELOG.md](../CHANGELOG.md).

| Era | Commits | Theme |
|-----|--------:|-------|
| v0.1.0 → v0.6.0 | 1,217 | Foundation → COW architecture, strategy/sync engine, credential daemon, AMA prototype, credit/MPA runtime |
| v0.6.0 → v1.0.0 | 309 | Zero-dependency & TS migration, native BitShares, fill detection overhaul, first stable release |
| v1.0.0 → v1.1.0 | 85 | Post-stable hardening, PnL analytics, auto-update, broadcast deadlock fixes |
| v1.1.0 → v1.3.3 | 114 | AMA refits, credit-only mode, COW recovery hardening, runtime extraction |
| v1.3.3 → v1.4.8 | 74 | CJS→ESM completion, concurrency correction, uncertain-broadcast safety, truncated-read ambiguity |
| v1.4.8 → v1.4.13 | 45 | Native ESM runtime, broadcast serialization, onboarding |
| v1.4.13 → v1.4.19 | 36 | Profile-state centralization, code consolidation, per-broadcast op cap |
| v1.4.19 → v1.4.20 | 5 | Grid boundary promotion hardening, recovery poison gate, analysis output centralization |
| v1.4.20 → v1.4.21 | 15 | Runtime audit fixes, claw dedup hardening, boundary ceiling alignment, editor color feedback |

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: August 24, 2026 (v1.4.21)
**Total Commits**: 2,067
**Date Range**: December 2, 2025 – August 24, 2026
**Repository**: DEXBot2 (BitShares DEX Trading Bot)
