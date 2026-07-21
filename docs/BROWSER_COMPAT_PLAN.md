# Browser Compatibility — Integration Plan

**Branch:** `test`  
**Audit date:** 2026-06-19  
**Goal:** Make the browser-safe surface truly safe — no Node built-in reaches a browser bundle.

---

## Phase 1 — Critical (HIGH) — Blocks any browser build

These cause immediate build/runtime failures. Fix first, one at a time, with unit-test coverage.

### 1.1 `modules/crypto/node_provider.ts` — Static ESM `import * as crypto`

**Problem:** Static `import * as crypto from 'crypto'` on line 1. `crypto/index.ts` (browser-safe) does a static `import { NodeCryptoProvider } from './node_provider'`, so every browser bundle will chase this import and crash.

**Fix:** Convert `node_provider.ts` to use lazy `require('crypto')` inside the class methods, matching the `sync.ts` pattern:

```typescript
// Replace top-level `import * as crypto from 'crypto'`
// with module-level lazy getter:
let _crypto: any;
function getNodeCrypto(): any {
    if (!_crypto) {
        try { _crypto = require('crypto'); } catch { _crypto = null; }
    }
    return _crypto;
}
```

Then replace every `crypto.createHash(...)` → `getNodeCrypto().createHash(...)`, etc.

Also make `crypto/index.ts` use `require()` instead of static `import` for `node_provider`:

```typescript
// Before:
import { NodeCryptoProvider } from './node_provider';
export { NodeCryptoProvider } from './node_provider';
// After (inside getCrypto):
let NodeCryptoProvider: any;
try { NodeCryptoProvider = require('./node_provider').NodeCryptoProvider; } catch {}
```

**Risk:** None — `getCrypto()` already branches on `isBrowser()`. Only the Node path is affected.

**Validation:**
```bash
# TypeScript still compiles
npm run typecheck
# Existing tests pass
npm test
# Verify browser-safe surface has no crypto import
rg "from ['\"]crypto['\"]" modules/crypto/ modules/claw/ modules/env.ts modules/runtime.ts modules/path_api.ts
```

---

### 1.2 `modules/bitshares-native/crypto/ecc.ts` — Static ESM `import * as crypto`

**Problem:** Line 3 `import * as crypto from 'crypto'`. Loaded via `ecc_selector.ts` dynamic `require()` — but many bundlers trace both branches of a `require()` and will parse this file. If `crypto` resolution fails, the bundle is dead.

**Fix:** Replace the ESM import with a lazy `require('crypto')` inside each function that needs it, or switch to `sync.ts` exports:

```typescript
// Before:
import * as crypto from 'crypto';
// After:
const { createHash, randomBytes, timingSafeEqual } = require('../crypto/sync');
```

Then replace `crypto.createHash(...)` → `createHash(...)`, etc. The `sync.ts` module already has the guarded lazy pattern.

**Risk:** Low — `ecc.ts` is only reached via `getEcc()` which already branches on `isBrowser()`.

**Validation:** Same as 1.1 plus verify dynamic require still works:
```bash
node -e "const getEcc = require('./dist/modules/bitshares-native/crypto/ecc_selector'); console.log(typeof getEcc());"
```

---

### 1.3 `market_adapter/candle_utils.ts` — Top-level `require('fs')`

**Problem:** Line 3 `const fs = require('fs')` — this file is pure candlestick math otherwise.

**Fix:** Wrap in try/catch or use `getStorage()` for the single write path. Check usage first.

**Validation:** `grep -n 'fs\.' market_adapter/candle_utils.ts` → confirm only I/O operations, replace with `getStorage()`.

---

### 1.4 `market_adapter/ama_signal_runner.ts` — Top-level `require('fs')`

**Problem:** Line 4 `const fs = require('fs')`. Shebang `#!/usr/bin/env node` — clearly node-only.

**Fix:** Either:
- Move to `scripts/` or `modules/launcher/` and add `browser: false` in package.json, OR
- Guard with `try/catch` + lazy `require('fs')` and document as node-only in AGENTS.md

**Validation:** Verify no browser-safe module imports from this file.

---

### 1.5 `market_adapter/utils/dynamic_grid_snapshot.ts` — Mixed `require('fs')` + `getStorage()`

**Problem:** Line 3 `const fs = require('fs')` alongside imports from `getStorage()` pattern. Partial migration.

**Fix:** Replace the 3 raw `fs.openSync`/`fs.closeSync`/`fs.renameSync` calls with `getStorage().open(...)`, `getStorage().close(...)`, `getStorage().rename(...)`.

**Validation:**
```bash
grep -n 'fs\.' market_adapter/utils/dynamic_grid_snapshot.ts
# → should be zero after fix
```

---

## Phase 2 — Medium — Structural gaps and unclassified patterns

### 2.1 `modules/paths.ts` — Fragile `__dirname` guard

**Problem:** Line 4 `typeof __dirname !== 'undefined' ? path.dirname(__dirname) : ''` — `__dirname` doesn't exist in ESM; fallback is empty string.

**Fix:** Use `import.meta.url` when available (ESM) or a configurable root:

```typescript
const MODULE_DIR = (() => {
    if (typeof __dirname !== 'undefined') return path.dirname(__dirname);
    if (typeof import.meta?.url !== 'undefined') return path.dirname(new URL(import.meta.url).pathname);
    return '';
})();
```

Or, for browser builds, make `PATHS` accept a configurable root or return empty defaults that produce no-ops when used.

**Risk:** Medium — every file-based path in the bot depends on `PATHS`. Browser context must not use these paths for I/O.

---

### 2.2 `modules/credential_runtime.ts` — Same `__dirname` pattern

**Problem:** Line 48 duplicate of 2.1. Also has lazy `require('./launcher/runtime_entry')`.

**Fix:** Same as 2.1. Add `hasProcess()` guard at the module top. Document as node-only.

---

### 2.3 `market_adapter/market_adapter.ts` — Direct `__filename` on line 119

**Problem:** `path.relative(PATHS.PROJECT_ROOT, __filename)` — no guard.

**Fix:** Guard with `typeof __filename !== 'undefined'` or compute from `import.meta.url`.

---

### 2.4 `modules/logger.ts` — Document existing split

**Problem:** Correctly branches via `isBrowser()` but missing from AGENTS.md browser-safe list.

**Fix:** Add `modules/logger.ts` to the browser-safe list in AGENTS.md.

---

### 2.5 `modules/order/logger.ts` — `process.env` fallback

**Problem:** Lines 12-18 fall through to `process.env.pm_exec_path` instead of `Config` only.

**Fix:** Remove `process.env` fallbacks — `Config` already reads these env vars.

---

### 2.6 `modules/process_discovery.ts` — Unclassified, reads `/proc/*`

**Fix:** Add to AGENTS.md as node-only. Add `browser: false` mapping in package.json.

---

### 2.7 `modules/graceful_shutdown.ts` — Unclassified, uses `process.on`

**Fix:** Add to AGENTS.md as node-only. Add `browser: false` mapping in package.json.

---

## Phase 3 — Low — Hardening and documentation

### 3.1 Complete `package.json` `"browser"` field

Add `false` mappings for all AGENTS.md node-only modules currently missing:

| Module | Entry |
|--------|-------|
| `modules/storage/node_adapter` | `"./dist/modules/storage/node_adapter.js": false` |
| `modules/key_store` | `"./dist/modules/key_store.js": false` |
| `modules/dexbot_maintenance_runtime` | `"./dist/modules/dexbot_maintenance_runtime.js": false` |
| `modules/order/logger` | `"./dist/modules/order/logger.js": false` |
| `modules/order/export` | `"./dist/modules/order/export.js": false` |
| `modules/order/runner` | `"./dist/modules/order/runner.js": false` |
| `modules/process_discovery` | `"./dist/modules/process_discovery.js": false` |
| `modules/graceful_shutdown` | `"./dist/modules/graceful_shutdown.js": false` |

---

### 3.2 Make `modules/order/index.ts` logger require lazy

**Problem:** Line 63 eagerly `require('./logger')` which has top-level `require('fs')`. If `order/index.ts` is loaded in browser context, it crashes.

**Fix:** Make the logger a lazy accessor:

```typescript
let _logger: any;
function getLogger(): any {
    if (!_logger) _logger = require('./logger');
    return _logger;
}
```

---

### 3.3 Make `modules/storage/index.ts` adapters lazy

**Problem:** Lines 22-23 do top-level `require('./node_adapter')` and `require('./browser_adapter')`. Bundlers may trace both paths.

**Fix:** Move `require()` calls inside the `getStorage()` branches:

```typescript
function getStorage() {
    if (_adapter) return _adapter;
    if (isBrowser()) {
        _adapter = require('./browser_adapter');
    } else {
        _adapter = new (require('./node_adapter'))();
    }
    return _adapter;
}
```

---

### 3.4 AGENTS.md — Classify all unclassified modules

From the audit, ~25 modules lack a browser-safe/node-only label. Add explicit classification entries.

**Suggested classifications:**

| Module | Label |
|--------|-------|
| `modules/constants.ts` | browser-safe |
| `modules/types.ts` | browser-safe |
| `modules/settings_merge.ts` | browser-safe |
| `modules/fund_registry.ts` | browser-safe (uses storage abstraction) |
| `modules/validate_profiles.ts` | ambiguous (uses storage) — review |
| `modules/authority_resolver.ts` | browser-safe (uses ecc, no fs/process) |
| `modules/cr_planner.ts` | browser-safe |
| `modules/credit_runtime.ts` | node-only |
| `modules/market_adapter_whitelist.ts` | ambiguous — review |
| `modules/node_health_cache.ts` | node-only |
| `modules/order/format.ts` | browser-safe |
| `modules/order/async_lock.ts` | browser-safe |
| `modules/order/logger_state.ts` | browser-safe |
| `modules/order/processed_fill_store.ts` | browser-safe |
| `modules/order/utils/math.ts` | browser-safe |
| `modules/order/utils/order.ts` | browser-safe |
| `modules/order/utils/system.ts` | ambiguous — review |
| `modules/order/utils/validate.ts` | browser-safe |
| `modules/utils/math_utils.ts` | browser-safe |
| `modules/utils/base58check.ts` | browser-safe (uses sync.ts) |
| `modules/dexbot_credential_client.ts` | node-only |

---

## Verification Checklist

After each phase, run:

```bash
# 1. TypeScript compilation
npm run typecheck

# 2. Unit tests
npm test

# 3. Verify no static ESM imports of Node builtins from browser-safe modules
rg "import\s+\*\s+as\s+\w+\s+from\s+['\"](?:fs|path|os|child_process|crypto|net|tls|http)['\"]" modules/crypto/ modules/claw/ modules/env.ts modules/runtime.ts modules/config.ts modules/path_api.ts modules/storage/

# 4. Verify no static ESM imports of node-only modules from browser-safe modules
rg "from\s+['\"]\.\.?/(?:launcher|key_store|dexbot_maintenance_runtime|order/(?:logger|export|runner))['\"]" modules/crypto/ modules/claw/ modules/env.ts modules/runtime.ts modules/config.ts modules/path_api.ts modules/storage/

# 5. Final — try a browser bundle (if bundler is in the toolchain)
# npx webpack --mode production --target web --entry some-browser-entry.ts
```

---

## Execution Order

```
Phase 1 (Critical) ──→ Phase 2 (Medium) ──→ Phase 3 (Low)
     │                       │                       │
     │  1.1 node_provider     │  2.1 paths.ts         │  3.1 package.json browser
     │  1.2 ecc.ts            │  2.2 credential_runtime│  3.2 order/index.ts lazy
     │  1.3 candle_utils      │  2.3 market_adapter.ts │  3.3 storage/index.ts lazy
     │  1.4 ama_signal_runner │  2.4 logger.ts docs    │  3.4 AGENTS.md classify
     │  1.5 dynamic_grid      │  2.5 order/logger.ts   │
     │                       │  2.6 process_discovery  │
     │                       │  2.7 graceful_shutdown  │
```

Each phase can be broken into individual commits (`fix: browser-compat — ...`). Run full validation after each commit.
