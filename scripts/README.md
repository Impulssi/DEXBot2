# DEXBot2 /scripts CLI Documentation

This guide provides a terminal-focused reference for the maintenance and diagnostic utilities available in the `scripts/` directory.

---

## 🛠️ CORE MAINTENANCE

### Update DEXBot2
**File:** `update.ts`
**Purpose:** Perform a safe, production-ready update.
```bash
# Pull latest code, install deps, and restart PM2
dexbot update
```
*Note: Protects your `profiles/` directory during the update process.*

---

## 🧹 CLEANING & RESET (DANGER ZONE)

### Wipe Logs
**File:** `clear-logs.sh`
**Purpose:** Delete all bot `.log` and `.jsonl` files, including `profiles/logs/market_adapter.log`.
```bash
# IRREVERSIBLE: Deletes all files in profiles/logs/*.log and *.jsonl, including market_adapter.log
# Prompts for confirmation before deleting.
bash scripts/clear-logs.sh
```

### Wipe Orders
**File:** `clear-orders.sh`
**Purpose:** Delete all persistent order state files.
```bash
# IRREVERSIBLE: Deletes all files in profiles/orders/*
# Prompts for confirmation before deleting.
bash scripts/clear-orders.sh
```

### Clear Market Adapter State
**File:** `clear-market-adapter.sh`
**Purpose:** Delete all market adapter candle data, state files, and runtime logs.
```bash
# IRREVERSIBLE: Removes market_adapter/data/, market_adapter/state/, and profiles/logs/{market_adapter,dexbot-adapter,dexbot-adapter-error}.log
# Prompts for confirmation before deleting.
bash scripts/clear-market-adapter.sh
```

### Wipe Orders + Logs + Market Adapter
**File:** `clear-all.sh`
**Purpose:** Delete order state files, log files, and market adapter data/state in one confirmed operation.
```bash
# IRREVERSIBLE: Deletes profiles/orders/*, profiles/logs/*.{log,jsonl}, market_adapter/data/*, and market_adapter/state/*
# Prompts for confirmation before deleting.
bash scripts/clear-all.sh
```

### Reset Settings
**File:** `reset-settings.sh`
**Purpose:** Delete the three settings files and restore built-in defaults on next run.
```bash
# IRREVERSIBLE: Deletes profiles/general.settings.json, profiles/market_profiles.json,
# and profiles/market_adapter_settings.json
# Prompts for confirmation before deleting.
bash scripts/reset-settings.sh
```

---

## 📊 DIAGNOSTICS & VALIDATION

### Configuration Audit
**File:** `validate_bots.ts`
**Purpose:** Check `bots.json` for schema errors or missing required fields.
```bash
# Validate the live bot configuration
tsx scripts/validate_bots.ts
```

### Market Adapter Whitelist Generation
**File:** `generate_market_adapter_whitelist.ts`
**Purpose:** Generate `profiles/market_adapter_whitelist.json` from bots whose `gridPrice` uses AMA mode.
```bash
# Add missing AMA bots from profiles/bots.json to profiles/market_adapter_whitelist.json.
# Existing entries are preserved; new entries enable AMA/range scaling and leave dynamicWeight disabled.
dexbot white

# Add missing AMA bots with dynamicWeight enabled for newly generated entries
dexbot white --dynamic-weight

# Add missing AMA bots with asymmetricBounds disabled for newly generated entries
dexbot white --no-asymmetric-bounds

# Remove whitelist entries for bots no longer in profiles/bots.json
dexbot white --prune

```

### Grid Divergence Audit
**File:** `divergence-calc.ts`
**Purpose:** Measure the "drift" between in-memory grid and disk state using RMS divergence metric.
```bash
# Calculates RMS Error (Default threshold is 14.3%)
# RMS quadratically penalizes large errors - see docs/README.md for threshold interpretation
tsx scripts/divergence-calc.ts
```
**Reference:** RMS threshold explanation in [root README GRID RECALCULATION section](../README.md#-automatic-grid-recalculation-via-threshold-detection)

### Grid Trading Analysis
**File:** `analyze-orders.ts`
**Purpose:** Analyze grid trading metrics and order distribution patterns.
```bash
# Analyzes spread accuracy, geometric consistency, and fund distribution
tsx scripts/analyze-orders.ts
```

For AMA bots (`gridPrice: ama`) the analyzer reads `<botKey>.dynamicgrid.json`
and, when fresh (`2 × MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds`, default 2h),
shows live weights with color: higher = red (losing), lower = green (winning),
static = grey. Stale snapshot appends a red `(adapter offline)` alert to the
static weights.

### Kibana Candle Diagnostics
**File:** `diagnose-kibana-candles.ts`
**Purpose:** Fetch raw Kibana LP candles for a specific pool to verify trading activity.
```bash
tsx scripts/diagnose-kibana-candles.ts
```

### Pool History Diagnostics
**File:** `diagnose-pool-history.ts`
**Purpose:** Inspect raw BitShares pool history API responses.
```bash
# Inspect pool history (default pool 1.19.133)
tsx scripts/diagnose-pool-history.ts

# Custom pool, limit, and time range
tsx scripts/diagnose-pool-history.ts --pool 1.19.x --limit 100 --hours 48 --maxPages 5
```

### Print Grid Sample
**File:** `print_grid.ts`
**Purpose:** Demonstrate the grid structure — shows consecutive price levels with percentage differences between adjacent slots.
```bash
tsx scripts/print_grid.ts
```

### Grid Calculation Runner
**File:** `runner.ts`
**Purpose:** Standalone order grid calculation debugger — loads a bot config, initializes the grid, and simulates sync cycles.
```bash
# Default (first bot, 3 cycles)
tsx scripts/runner.ts

# Specific bot, 10 cycles with 1s delay
LIVE_BOT_NAME=my-bot CALC_CYCLES=10 CALC_DELAY_MS=1000 tsx scripts/runner.ts
```
Useful for verifying config produces the expected grid, testing price derivation, and debugging fund allocation.
Requires a live BitShares connection (asset metadata lookups and price derivation are on-chain).

---

## 🔍 GIT & DEVELOPMENT WORKFLOW

### Interactive Git Changes Monitor
**File:** `git-viewer.sh`
**Purpose:** Interactive monitor for uncommitted, committed, and pushed changes.
```bash
# Launch interactive git changes viewer with fzf search
bash scripts/git-viewer.sh
```

**Features**:
- View uncommitted (working tree) changes
- View committed (staged) changes
- View pushed vs. remote-tracking changes
- Smart auto-refresh (1s for local, 15s for remote)
- Fuzzy search with `fzf` for finding files
- Toggle between full file view and diff-only view

**Usage**:
```bash
# Press '1' to view all changes
# Press '2' to search uncommitted files (with fzf)
# Press '3' to search unpushed commits (with fzf)
# Press '4' to search pushed commits (with fzf)
# Press 'q' to quit
```
Inside file viewer: `f` full file, `d` diff view, `q` back to search, `b` main menu.

---

## 💻 DEVELOPMENT UTILITIES

### Test Suite Setup
Tests run with native Node `assert` — no test framework needed. See [tests/README.md](../tests/README.md) for details.

### Repository Statistics Analyzer
**File:** `analyze-git.ts`
**Purpose:** Analyze git history and generate a chart of lines added vs deleted by file.
```bash
tsx scripts/analyze-git.ts
```

### Credit Renewal Test
**File:** `test-credit-renewal.ts`
**Purpose:** Test credit offer renewal for a specific bot against the live chain.
```bash
npm run test:credit-renewal
```

### Browser Bundle Verification
**File:** `verify-browser-bundle.ts`
**Purpose:** Verify that the browser-safe surface actually bundles for the web (source-level and dist-level checks).
```bash
npm run verify:browser-bundle
```

### Create PM2 Bot Symlinks
**File:** `create-bot-symlinks.sh`
**Purpose:** Create `profiles/<bot-name>.config.js` symlinks pointing to `profiles/ecosystem.config.js` so you can run `pm2 start <bot-name>` directly.
```bash
bash scripts/create-bot-symlinks.sh
```
Auto-runs on `npm postinstall` for global installs.

### Version Sync
**File:** `sync-version.ts`
**Purpose:** Keep DEXBot2-owned package and plugin manifests aligned to the root `package.json` version.
```bash
# Check that package-lock.json and Claw manifests match root package.json
npm run version:check

# Rewrite aligned manifests from root package.json
npm run version:sync
```
---

## 🌳 BRANCH SYNCHRONIZATION

### Synchronize test → dev → main
**File:** `pmain.sh` (also: `npm run pmain`)
**Purpose:** Sync local test branch through dev to main remote.
```bash
# Push test → dev → main
bash scripts/pmain.sh
# OR
npm run pmain
```

### Synchronize test → dev
**File:** `pdev.sh` (also: `npm run pdev`)
**Purpose:** Sync local test branch to dev remote.
```bash
# Push test → dev
bash scripts/pdev.sh
# OR
npm run pdev
```

### Synchronize local test → origin/test
**File:** `ptest.sh` (also: `npm run ptest`)
**Purpose:** Push local test branch to remote.
```bash
# Push test to origin/test
bash scripts/ptest.sh
# OR
npm run ptest
```

---

## ⚡ CONVENIENCE WRAPPERS

The following scripts allow you to call `dexbot` commands directly from the `scripts/` directory:

| Wrapper | Target Command | Usage |
|:---|:---|:---|
| `scripts/bots` | `dexbot bot` | `./scripts/bots` |
| `scripts/keys` | `dexbot key` | `./scripts/keys` |
| `scripts/dexbot` | `dexbot` | `./dexbot <cmd>` |
| `scripts/unlock` | `./unlock` | `./unlock` |
| `scripts/pm2` | `./pm2` | `./pm2` |

---

## 📦 NPM SCRIPTS

| Command | File | Purpose |
|:---|:---|:---|
| `npm test` | `scripts/run-tests.ts` | Run full test suite (excludes live-chain tests) |
| `npm run test:live` | `scripts/run-tests.ts` | Run full test suite including live-chain tests |
| `npm run typecheck` | — | TypeScript type checking (`tsc --noEmit || true`) |
| `npm run build` | — | Clean + compile TypeScript |
| `npm run clean` | `scripts/clean-dist.js` | Remove compiled `dist/` output |
| `npm run ptest` | `scripts/ptest.sh` | Sync local test → origin/test |
| `npm run pdev` | `scripts/pdev.sh` | Sync local test → dev |
| `npm run pmain` | `scripts/pmain.sh` | Sync local test → dev → main |
| `npm run unlock` | `unlock.ts` | Build + single-prompt credential unlock (full bot) |
| `npm run claw:unlock` | `unlock.ts` | Build + single-prompt unlock (claw-only mode) |
| `npm run pm2:unlock` | `pm2.ts` | Build + launch full bot via PM2 ecosystem |
| `npm run pm2:claw-only` | `pm2.ts` | Build + launch claw-only PM2 process |
| `npm run lp:chart` | `scripts/generate_lp_chart.ts` | Generate uPlot LP chart |
| `npm run market-adapter:whitelist` | `scripts/generate_market_adapter_whitelist.ts` | Generate/update whitelist from AMA-configured bots |
| `npm run analysis:derivatives` | `analysis/analyze_derivatives.ts` | Derivative analysis report |
| `npm run version:sync` | `scripts/sync-version.ts` | Rewrite plugin/manifest versions from root `package.json` |
| `npm run version:check` | `scripts/sync-version.ts --check` | Verify all version manifests match root `package.json` |
| `npm run native:release-gates` | `scripts/native_release_gates.ts` | Verify native library build, linkage, and mainnet corpus round-trips |
| `npm run native:serial-snapshots` | `tests/test_native_serial_ops.ts` | Pin wire-format bytes for signed operation types |
| `npm run native:ecc-invariants` | `tests/test_native_ecc.ts` | Validate ECDH key derivation, ECDSA signing, WIF, brain key, and hash functions |
| `npm run native:corpus` | `scripts/generate_mainnet_corpus_report.ts` | Generate `profiles/native_validation/mainnet_corpus_report.json` by reserializing recent mainnet transactions through the native serializer and diffing against the chain's own `get_transaction_hex` output (and `block.transaction_ids` when the node exposes them) |
| `npm run test:credit-renewal` | `scripts/test-credit-renewal.ts` | Test credit offer renewal for a specific bot |
| `npm run verify:browser-bundle` | `scripts/verify-browser-bundle.ts` | Verify browser-safe surface bundles correctly |

---

## 📈 CHART GENERATION

### LP Chart
**File:** `generate_lp_chart.ts`
**Purpose:** Generate the standard uPlot LP chart output.
```bash
# Generate the default LP chart flow
npm run lp:chart -- --data <lp-export.json>
# --file is an alias for --data
```

### Local LP Comparison Chart
**File:** `analysis/ama_fitting/generate_unified_comparison_chart.ts`
**Purpose:** Generate the local LP comparison chart from an LP candle export.
**Output:** `analysis/charts/lp_chart_<interval>_UNIFIED_COMPARISON.html`
```bash
# Generate the local LP comparison chart
npm run ama:chart:lp-local -- --data <lp-export.json>
```

### Derivative Trend Analysis
**File:** `analysis/analyze_derivatives.ts`
**Purpose:** Generate the derivative analysis report.
```bash
# Generate the derivative analysis report
npm run analysis:derivatives -- --source json --file <file.json>
```

---

## 📚 DOCUMENTATION REFERENCES

For understanding the systems these scripts interact with:
- **Module Architecture**: See [root README 📦 Modules section](../README.md#-modules)
- **Copy-on-Write Pattern**: See [docs/COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md) for rebalancing architecture
- **Fund Accounting**: See [docs/FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)
- **Grid Divergence**: See [docs](../docs/README.md) for RMS threshold explanations
- **Logging System**: See [docs/LOGGING.md](../docs/LOGGING.md) for log configuration and levels

## ⌨️ TERMINAL PRODUCTIVITY

Boost your workflow by adding these aliases to your `~/.bashrc` or `~/.zshrc`:

```bash
# DEXBot2 Shortcuts
alias dbu='dexbot update'
alias dbc='bash scripts/clear-logs.sh'
alias dbr='bash scripts/clear-orders.sh'
alias dba='bash scripts/clear-all.sh'
alias dbv='tsx scripts/validate_bots.ts'
alias dbd='tsx scripts/divergence-calc.ts'
```

---

## 💡 PRO-TIPS FOR TERMINAL USERS

**Monitor live updates while running a script:**
```bash
# Tail the update log in a separate pane
tail -f profiles/logs/update.log
```

**Run a specific bot dry-run from the CLI:**
```bash
# Force a clean start for 'my-bot'
bash scripts/clear-orders.sh && BOT_NAME=my-bot dexbot test
```
