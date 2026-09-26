# Development Context - DEXBot2

## Branch Strategy & Git Action Gate
**Pipeline: `test` → `dev` → `main`** (ONE DIRECTION ONLY — never `dev` → `test`).

- Git write actions (`add`, `commit`/`commit --amend`, `reset`, `rebase`, `merge`, `push`, `tag`, `checkout`/`switch`, plus `npm run ptest`/`pdev`/`pmain`) run **only on explicit user request**. Read-only commands (`status`, `diff`, `log`, `show`) are always allowed.
- Short approvals ("yes", "ok", "do it") count only if they clearly refer to the immediately previous proposed action. If ambiguous, ask first. Restate authorization in one line before executing.
- Branch promotion defaults to manual merge/push flow; use the `ptest`/`pdev`/`pmain` force-push scripts only when explicitly asked (they mirror `test` downstream, no merge commit, no tagging).

See `docs/WORKFLOW.md` for the full workflow guide.

## Commit Quality Standard
Conventional prefix (`fix:`, `feat:`, `docs:`) + body explaining **why** for non-trivial changes.

- Include file path(s) and behavioral impact; note risks and test commands when relevant.
- Never include real account/bot names, market/pair names, addresses, or other live identifiers in commits, PRs, CHANGELOG, or docs — use generic terms (`a live market-pair bot`) and placeholders (`account-name`, `<market-pair>`). Scan before committing; amend if one slips in.
- Keep commits atomic. Stage with `git add <scope>`; NEVER `git checkout --` / `git restore` dirty files belonging to a future commit.

## Key Files
- Entry: `dexbot.ts`, `bot.ts`, `pm2.ts`, `unlock.ts`, `credential-daemon.ts`
- Core: `modules/dexbot_class.ts`, `modules/constants.ts`, `modules/bot_defaults.ts`, `modules/fund_registry.ts`, `modules/settings_merge.ts`, `modules/credit_runtime.ts`, `modules/credit_pricing.ts`
- Orders: `modules/order/manager.ts`, `strategy.ts`, `accounting.ts`, `sync_engine.ts`, `grid.ts`, `working_grid.ts`
- Chain: `modules/chain_orders.ts`, `modules/account_orders.ts`, `modules/bitshares_client.ts`, `modules/node_manager.ts`
- Config: `profiles/bots.json`, `profiles/general.settings.json` + `profiles/market_profiles.json` (auto-generated on first run)
- Market adapter: `market_adapter/market_adapter.ts`, `core/market_adapter_service.ts`

Full maps (don't duplicate here): `docs/architecture.md`, `docs/developer_guide.md`, `docs/LIFECYCLE.md`, `modules/README.md`, `market_adapter/README.md`, `analysis/README.md`, `tests/README.md`.

## Version Management
1. Bump `version` in `package.json`.
2. `npm run version:check` (dry-run) → `npm run version:sync` (source of truth: `scripts/sync-version.js`).
3. Update `CHANGELOG.md` (all changes since last tag) + `docs/EVOLUTION.md` + its footer (commit count, version/date).

## Browser-Safe Surface
Everything is browser-safe unless mapped to `false` in the `package.json` `"browser"` field — always check it before (re)classifying. Env detection only via `modules/env.ts` (`isBrowser`, `hasProcess`); never inline `typeof window`/`process` checks.

## Config Caching Trap (Tests)

`modules/config.ts` snapshots `process.env` values **at module-load time**. Any test setting `process.env.X` after a `require()` that transitively loads `config.ts` will have no effect. Fix: set env var at line 1 before any `require()`, or mutate `Config.X` directly after loading it.
