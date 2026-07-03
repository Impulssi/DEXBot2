# Development Context - DEXBot2

## Branch Strategy
**Pipeline: `test` → `dev` → `main`** (ONE DIRECTION ONLY!)

- **test**: Primary development branch (where work happens)
- **dev**: Integration/staging (merged from test)
- **main**: Production-ready (merged from dev)

⚠️ **KEY RULE**: Always merge **test → dev**, NEVER dev → test
⚠️ **KEY RULE**: See **Absolute Git Action Gate** below for all write-action authorization rules.
⚠️ **KEY RULE**: Default to manual merge/push flow for branch promotion when requested, unless the user specifically asks to use one of the sync scripts.

## Absolute Git Action Gate (User-Directed Writes)

**Agent must NOT proactively ask for or execute git write actions.**
The agent only runs git write actions when the user clearly requests them.

Git write actions include:
- `git add`
- `git commit`
- `git commit --amend`
- `git reset` (any mode)
- `git rebase`
- `git merge`
- `git push`
- `git tag`
- `git checkout` / `git switch` to another branch

Branch-promotion scripts include:
- `npm run ptest`
- `npm run pdev`
- `npm run pmain`

Read-only git commands are always allowed (for example: `git status`, `git diff`, `git log`, `git show`).

Interpretation rules:
1. If a user clearly asks for a git write action, execute it.
2. Short approvals like "yes", "ok", "do it", or "go ahead" are valid confirmation when they clearly refer to the immediately previous proposed action.
3. If wording is ambiguous, ask one clarifying question before running destructive actions.
4. `git commit --amend` is allowed when explicitly requested by the user.
5. Before a git write action, restate the user authorization in one short line.

See `docs/WORKFLOW.md` for detailed workflow guide.

## Commit Quality Standard
When creating commits, prefer high-context commit messages for non-trivial fixes/features.

- **Subject**: concise conventional prefix (`fix:`, `feat:`, `docs:`) with clear scope.
- **Body required for substantial changes**: explain **why**, not only what changed.
- **Structure**:
  1. Short problem statement/context
  2. Per-fix sections with file path(s) and behavioral impact
  3. Risk/edge-case notes when relevant
  4. Validation/testing notes (commands or scenario checks)
- **Formatting**: use readable markdown headers/bullets in commit body for scanability.
- **CLI formatting safety**:
  - Never use `/n` or literal `\\n` text as a newline placeholder in commit/PR bodies.
  - Always pass real newlines to Git/GitHub (multi-line body), not escaped newline text.
  - Prefer heredocs for reliability when using `git commit` and `gh pr create`.
- **Atomicity**: keep unrelated edits out of the commit; document only included changes.
- **Tone**: use professional, concise language — no personal commentary, verbose explanations, or markdown section headers in commit bodies. Stick to the facts: what changed and why.
- **Unrelated working-tree files**: if the diff includes pre-existing dirty files the user wants in a separate commit, use `git add <scope>` to stage only the relevant files. NEVER run `git checkout -- <file>` or `git restore <file>` on those files — that destroys the working-tree content. Let them stay dirty for a future commit.

Recommended CLI patterns (newline-safe):

```bash
# Commit message with proper markdown/newlines
git commit -F- <<'EOF'
fix: <short summary>

<context>

## <Fix area>
- Problem:
- Impact:
- Solution:

## Testing Notes
- <test command>
EOF

# PR body with proper markdown/newlines
gh pr create --title "<title>" --body-file - <<'EOF'
## Summary
- <item>

## Testing
- <command>
EOF
```

Recommended template:

```text
fix: <short summary>

<1-2 line context>

## <Fix area 1>
File: <path>
- Problem:
- Impact:
- Solution:

## <Fix area 2>
File: <path>
- Problem:
- Impact:
- Solution:

## Testing Notes
- <test/verification>
```

## Key Files

### Entry Points
- `dexbot.ts` - Main CLI entry point
- `bot.ts` - Alternative bot starter
- `pm2.ts` - PM2 process management
- `unlock.ts` - Single-prompt starter (no PM2)
- `credential-daemon.ts` - Credential daemon

### Core Bot
- `modules/dexbot_class.ts` - Core bot class, lifecycle orchestration, and shared runtime wiring
- `modules/dexbot_fill_runtime.ts` - Fill processing runtime and replay-safe accounting helpers
- `modules/dexbot_maintenance_runtime.ts` - Maintenance runtime for sync loops and grid checks
- `modules/constants.ts` - Centralized configuration and tuning parameters
- `modules/bitshares_client.ts` - BitShares connection and node management
- `modules/node_manager.ts` - Multi-node health checking and failover
- `modules/fund_registry.ts` - Shared-account fund registry with cross-bot invariants
- `modules/settings_merge.ts` - Consolidated settings merge (single source of truth)
- `modules/cr_planner.ts` - Pure math / credit planning
- `modules/credit_runtime.ts` - Credit offer and MPA debt lifecycle management

### Order Management (`modules/order/`)
- `manager.ts` - Order lifecycle and state management
- `grid.ts` - Grid calculation, placement, and management
- `working_grid.ts` - Copy-on-write working grid
- `strategy.ts` - Trading strategy (anchor & refill, consolidation)
- `accounting.ts` - Fee accounting and fund tracking
- `sync_engine.ts` - Blockchain synchronization
- `grid_reconcile.ts` - Startup grid reconciliation
- `runner.ts` - Order execution runner
- `logger.ts` - Order logging
- `utils/` - Utilities (math, order, system, validate)

### Market Adapter (`market_adapter/`)
- `market_adapter.ts` - AMA delta threshold, grid price offset, and recalc triggers
- `core/market_adapter_service.ts` - Price adapter service core (offset, bound clamping)
- `ama_signal_runner.ts` - AMA signal processing
- `inputs/` - Kibana and LP data sources
- `candle_utils.ts` - Candlestick utilities

### Blockchain Interaction
- `modules/chain_orders.ts` - Blockchain order operations
- `modules/account_orders.ts` - Account order queries

### Configuration
- `profiles/bots.json` - Bot configuration
- `profiles/general.settings.json` - Global settings (auto-generated on first run; file may not exist until first launch)
- `profiles/market_profiles.json` - Market-specific settings (AMA params, price offset params; auto-generated on first run)

### Claw Integration (`claw/`)
- `claw/index.ts` - Main export combining all modules
- `claw/skills/` - Agent skill packages (bitshares-guide, launcher-ops, margin-trading, etc.)
- `claw/modules/claw_bridge.ts` - JSON bridge for runtime integration
- `claw/modules/claw_catalog.ts` - Command catalog for bridge dispatch
- `claw/modules/claw_manifest.ts` - Runtime manifest
- `claw/modules/claw_infra.ts` - Shared runtime infrastructure
- `claw/modules/bitshares_client.ts` - BitShares connection, queries, broadcast
- `claw/modules/chain_actions.ts` - High-level chain operations (limit orders, MPA, credit)
- `claw/modules/credit_runtime_adapter.ts` - Credit runtime lifecycle bridge
- `claw/modules/decision_loop.ts` - Position evaluation orchestration
- `claw/modules/dexbot_profiles.ts` - DEXBot2 profile reader
- `claw/modules/dexbot_credential_client.ts` - Credential daemon client
- `claw/modules/feed_price_source.ts` / `kibana_price_source.ts` - Price sources
- `claw/modules/honest_ecosystem.ts` - HONEST asset helpers
- `claw/modules/position_manager.ts` - Position tracking
- `claw/modules/position_health.ts` - Position health monitoring
- `claw/modules/short_mpa_strategy.ts` - Short MPA workflow

### Vendored Libraries
- `analysis/uplot/` - uPlot v1.6.32 charting library (vendored, no CDN dependency)

### Analysis Tools (`analysis/`)
Research scripts for parameter tuning — output interactive HTML charts, not used in production.
- `analysis/README.md` - top-level index and folder map
- `analyze_dynamic_weight.ts` / `trend_detection/dynamic_weight_chart_generator.ts` - Dynamic weight research
- `analyze_derivatives.ts` / `trend_detection/derivative_analyzer.ts` - SMA/MACD/RSI signal analysis
- `trend_detection/kalman_trend_analyzer.ts` - Kalman filter trend analysis
- `ama_fitting/optimizer_high_resolution.ts` - AMA parameter optimization
- `analysis/price_sources.ts` - Unified candle source abstraction
- Docs in `analysis/trend_detection/`

### Testing
- `tests/` - Comprehensive test suite (unit, integration, scenario tests)

## Version Management

When bumping the version for a release:

1. Update `version` in `package.json` to the new version.
2. Run `npm run version:sync` — syncs all manifest files (`package-lock.json`,
   `claw/package.json`, `claw/runtimes/openclaw-plugin/*.json`,
   `analysis/ama_fitting/package.json`, `claw/tests/test_claw_mcp_transport.ts`,
   `docs/README.md`, `docs/DEXBOT_COMPARISON.md`,
   `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`, `docs/EVOLUTION.md`).
3. Add entries to `CHANGELOG.md` and `docs/EVOLUTION.md`, then update the
   EVOLUTION.md footer (commit count, last updated version/date).
4. Commit the version bump + docs.

```bash
# Check what would change (dry-run)
npm run version:check

# Apply version sync
npm run version:sync
```

## Quick Commands
```bash
# Create feature
git checkout test && git pull origin test
git checkout -b feature/my-feature test

# Merge to test
git checkout test && git pull origin test && git merge --no-ff feature/my-feature && git push origin test

# Integrate to dev
git checkout dev && git pull origin dev && git merge --no-ff test && git push origin dev

# Release to main
git checkout main && git pull origin main && git merge --no-ff dev && git push origin main
```

## Browser-Safe Surface

When adding or modifying code, respect the Node-vs-browser split. The bot
ships both a Node CLI runtime and the building blocks for an in-browser
operator UI; mixing the two surfaces inside a shared module is the most
common cause of `require('fs')` / `process.kill` / Unix-socket regressions
in the browser bundle.

**Convention: everything is browser-safe unless listed below as Node-only.**

**Enforcement:** `package.json` "browser" field is the source of truth — it maps every
Node-only **compiled** entry (dist/*.js) to `false`. The list below is documentation
only; always check `package.json` before adding or removing a classification.

**Node-only** (must not be reached from a browser bundle):
- `modules/launcher/*` — credential daemon, bot supervisor, market adapter runtime, monolithic runtime
- `modules/dexbot_maintenance_runtime.ts` — direct `fs` / `child_process` / `os` use
- `modules/dexbot_class.ts` — imports `dexbot_maintenance_runtime`
- `unlock.ts`, `bot.ts`, `dexbot.ts`, `pm2.ts`, `credential-daemon.ts` — CLI entry points
- `market_adapter/lp_chart_runner.ts` — `require('child_process')` for chart rendering

**Environment detection** — always go through `modules/env.ts`:
```ts
import { isBrowser, hasProcess } from './env';
```
Do not inline `typeof window` / `typeof globalThis.window` / `typeof process` checks. The 6+ inline ternaries that used to exist in `bitshares-native/*` and `runtime.ts` were consolidated into the helpers above.

## Config Caching Trap (Tests)

`modules/config.ts` snapshots `process.env` values **at module-load time**. Any test setting `process.env.X` after a `require()` that transitively loads `config.ts` will have no effect. Fix: set env var at line 1 before any `require()`, or mutate `Config.X` directly after loading it.
