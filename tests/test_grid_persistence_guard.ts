/**
 * Grid Persistence Guard — Static Analysis
 *
 * Failure mode being guarded:
 *   A code path mutates the master grid via `_updateOrder()` or
 *   `applyGridUpdateBatch()` (both go through `_applyOrderUpdate` and
 *   therefore mark the in-memory master grid dirty), but no `persistGrid()`
 *   or `flushGridDirty()` call exists in the same function body to
 *   snapshot the change to disk. After a restart, the on-disk grid will
 *   be stale.
 *
 *   The historical regression: slot-108 size 0.3293 → 0.0001 was applied
 *   to the in-memory master grid by the sync engine, but a partial-only
 *   fill batch produced no COW actions, so `_executeBatchIfNeeded` early
 *   returned without reaching any `persistGrid()` site — and the on-disk
 *   JSON retained the stale 0.3293.
 *
 * This test statically scans every non-test `.ts` file under `modules/`
 * and `market_adapter/`, locates every function/method body, and for any
 * function that calls `_updateOrder(` or `applyGridUpdateBatch(` (a
 * master-grid mutation), verifies the same function body also contains
 * at least one `persistGrid(` or `flushGridDirty(` call. The CI guard
 * fails if a new caller is added that violates this invariant.
 *
 * IMPORTANT: This is a defense-in-depth backstop, not a formal proof.
 * The scanner uses brace/paren counting with string/regex/template-
 * literal skipping, and is heuristic. It can be defeated by unusual
 * syntax (computed member access, complex template strings, arrow
 * functions with destructured parameters, etc.). The scanner's job is
 * to catch the COMMON case of a developer adding a new caller that
 * mutates the grid but forgets to persist it. For anything the scanner
 * cannot classify confidently, the documented WHITELIST_FUNCTIONS set
 * is the explicit escape hatch — adding a function there is itself a
 * signal that the caller is responsible for persistence elsewhere.
 * The runtime safety net (`flushGridDirty` at the end of every fill-
 * processing tick in `dexbot_class.ts`) is what guarantees correctness
 * even if the static guard misses a case.
 *
 * Whitelisted helper methods (their internal calls to `_updateOrder` are
 * considered protected by the outer caller's persist):
 *   - `OrderManager._applyOrderUpdate`     — the implementation itself
 *   - `OrderManager._updateOrder`          — public façade
 *   - `OrderManager.applyGridUpdateBatch`  — batch façade
 *
 * Note: `OrderManager._applyRecoverableGridUpdates` and other DEXBot-level
 * helpers are NOT in the whitelist — they self-satisfy the invariant by
 * containing a `persistGrid()` / `flushGridDirty()` call in the same body
 * (the scanner picks that up directly). Only functions whose body has
 * the mutation but relies on an external caller to persist belong here.
 */

const fs = require('fs');
const path = require('path');

console.log('=== Grid Persistence Guard (Static Analysis) ===\n');

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const SCAN_DIRS = [
    path.join(__dirname, '../modules'),
    path.join(__dirname, '../market_adapter')
];

const SCAN_EXTENSIONS = ['.ts'];

// Mutations that mark the in-memory master grid dirty and therefore
// require a matching persistGrid() / flushGridDirty() in the same function.
const MUTATION_PATTERNS = [
    /\._updateOrder\s*\(/,
    /\._updateOrderAtomic\s*\(/,
    /applyGridUpdateBatch\s*\(/
];

// Persistence primitives that satisfy the invariant.
const PERSIST_PATTERNS = [
    /\.persistGrid\s*\(/,
    /\.flushGridDirty\s*\(/
];

// Functions/methods that are themselves persistence-safe and whose
// internal _updateOrder calls do not need to be matched to a persistGrid
// in the same body. Each entry is a comment explaining WHY.
const WHITELIST_FUNCTIONS = new Set([
    // Implementation of the dirty-flag mutator — persistGrid is the
    // CALLER's responsibility, not this method's.
    '_applyOrderUpdate',
    // Public façade — callers are responsible for persistence.
    '_updateOrder',
    // Batch façade — same.
    'applyGridUpdateBatch',
    // The dirty-flag persistence primitives themselves.
    'flushGridDirty',
    'persistGrid',

    // ── Internal helpers called from a path that already has a persist site
    //    in the dexbot_class.ts wrapper, or by the new end-of-tick
    //    flushGridDirty() safety net. Adding a new entry here should be
    //    accompanied by a comment naming the persist owner. ──

    // Called by OrderManager.processFilledOrders, which is called by
    // DEXBot._processFillsWithBatching — that function now ends with
    // a flushGridDirty() call that catches any in-memory mutation here.
    'processFillsOnly',

    // OrderManager internal call: virtualizes a dust-timer slot. The
    // surrounding dust-timer / cancellation loop is itself driven by
    // a sync that flushes via the end-of-tick safety net.
    '_applyDustTimerCleanup',

    // OrderManager internal: invoked from _executeBatchIfNeeded no-op
    // path (which now has flushGridDirty) and from recovery paths in
    // dexbot_class.ts that all have explicit persistGrid sites.
    '_clearWorkingGridRef',

    // DEXBot internal (dexbot_class.ts): applies applyGridUpdateBatch to commit COW
    // outcomes. The CALLER (COW success path in updateOrdersOnChainBatchCOW)
    // owns the persistGrid() call immediately after, so this helper
    // itself does not need its own persistGrid().
    '_processBatchResults',

    // COW runtime (dexbot_cow_runtime.ts): called from updateOrdersOnChainBatchCOW
    // which owns the persistGrid() call immediately after processBatchResults.
    'processBatchResults'
]);

// Files where the invariant is enforced elsewhere (e.g. by the dirty-flag
// end-of-tick safety net or by a higher-level wrapper) and where per-
// function matching would produce too many false positives.
const FILE_SKIP_LIST = new Set([
    'test_', 'repro_'
]);

// ----------------------------------------------------------------------------
// Function-body scanner
// ----------------------------------------------------------------------------

/**
 * Strip line comments and block comments from a line so they cannot
 * produce false matches. Naive but adequate for source we control.
 *
 * @param {string} line - Original source line
 * @returns {string} Line with comments replaced by spaces
 */
function stripComments(line) {
    let result = line;
    const blockStart = result.indexOf('/*');
    const blockEnd = result.indexOf('*/');
    if (blockStart !== -1) {
        if (blockEnd !== -1 && blockEnd > blockStart) {
            result = result.slice(0, blockStart) + ' '.repeat(blockEnd - blockStart + 2) + result.slice(blockEnd + 2);
        } else {
            result = result.slice(0, blockStart);
        }
    }
    const lineComment = result.indexOf('//');
    if (lineComment !== -1) {
        result = result.slice(0, lineComment);
    }
    return result;
}

/**
 * Walk the source lines and produce a list of function-body regions
 * (zero-based line indices, inclusive start, exclusive end).
 *
 * Detection: any line that looks like a method/function declaration that
 * ends in `{` (after stripping the parameter list and optional return
 * type) opens a body. The matching `}` is found by counting braces from
 * that point forward, while respecting string literals, template
 * literals, and regex literals so that braces inside them do not
 * confuse the counter.
 *
 * @param {string[]} lines - Source lines
 * @returns {Array<{name: string, start: number, end: number, lineNo: number}>}
 */
function findFunctionBodies(lines) {
    const bodies = [];
    // Match a real function/method declaration. MUST contain either a
    // name before `(`, or the `function` keyword, or an arrow `=>`.
    // This explicitly excludes control-flow statements like `if`, `for`,
    // `while`, `switch`, `try`, `catch` which have no name.
    // The name regex requires the name to be the first identifier on the
    // line (after optional `async`, `static`, `public`, `private`,
    // `protected`, `readonly` modifiers) — this excludes expressions
    // like `throw new Error(...)`, `someValue.method(...)`, etc.
    const FUNCTION_NAME_RE = /^\s*(?:(?:async|static|public|private|protected|readonly|abstract|override|export)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
    const FUNCTION_KEYWORD_RE = /^\s*(?:export\s+)?(?:async\s+)?function\b/;
    const GETTER_SETTER_RE = /^\s*(?:get|set)\s+[A-Za-z_$][\w$]*\s*\(/;
    const ARROW_RE = /=>\s*\{/;
    const CONTROL_FLOW_RE = /^\s*(?:if|for|while|switch|try|catch|do|else|class|interface|type)\b/;

    // JavaScript built-in names that look like function calls but never
    // appear as the name of a function declaration in our codebase.
    const BUILTIN_NAMES = new Set([
        'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
        'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'RegExp',
        'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
        'JSON', 'Math', 'Reflect', 'Proxy', 'Function',
        'import', 'require', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
        'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
        'eval', 'undefined', 'null', 'NaN', 'Infinity',
        'console', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'setImmediate', 'clearImmediate', 'queueMicrotask', 'process',
        'Buffer', 'globalThis', 'global', 'window', 'document',
        'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
        'propertyIsEnumerable', 'toLocaleString', 'constructor',
        'join', 'slice', 'splice', 'concat', 'push', 'pop', 'shift', 'unshift',
        'forEach', 'map', 'filter', 'reduce', 'reduceRight', 'find', 'findIndex',
        'some', 'every', 'includes', 'indexOf', 'lastIndexOf',
        'sort', 'reverse', 'fill', 'copyWithin', 'entries', 'keys', 'values',
        'freeze', 'isFrozen', 'seal', 'isSealed', 'isExtensible',
        'getOwnPropertyDescriptor', 'getOwnPropertyNames', 'create',
        'defineProperty', 'assign', 'getPrototypeOf', 'setPrototypeOf',
        'hasInstance', 'charAt', 'charCodeAt', 'codePointAt', 'concat',
        'endsWith', 'startsWith', 'repeat', 'padStart', 'padEnd', 'trim',
        'toUpperCase', 'toLowerCase', 'normalize', 'match', 'matchAll',
        'replace', 'replaceAll', 'search', 'substr', 'substring', 'split',
        'fromCharCode', 'fromCodePoint', 'raw', 'apply', 'call', 'bind',
        'now', 'getTime', 'getDate', 'getDay', 'getFullYear', 'getHours',
        'getMilliseconds', 'getMinutes', 'getMonth', 'getSeconds',
        'getTimezoneOffset', 'getUTCDate', 'getUTCDay', 'getUTCFullYear',
        'getUTCHours', 'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth',
        'getUTCSeconds', 'getYear', 'setDate', 'setFullYear', 'setHours',
        'setMilliseconds', 'setMinutes', 'setMonth', 'setSeconds', 'setTime',
        'setUTCDate', 'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds',
        'setUTCMinutes', 'setUTCMonth', 'setUTCSeconds', 'setYear',
        'toDateString', 'toISOString', 'toJSON', 'toTimeString', 'toUTCString',
        'test', 'exec', 'compile', 'source', 'flags', 'global', 'ignoreCase',
        'multiline', 'sticky', 'unicode', 'lastIndex', 'groups', 'indices',
        'destructor'
    ]);

    // First pass: find all candidate function bodies, including nested.
    // Second pass: filter to top-level declarations only (i.e. not
    // contained within an already-detected body's line range).
    const allBodies = [];

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = stripComments(raw);

        // Skip comment-only and blank lines.
        if (!line.trim()) continue;
        // Skip lines that begin with a closing brace or other statement
        // continuation — these cannot be function declarations.
        if (/^\s*[})\]]/.test(line)) continue;
        // Skip class declarations (no body should be scanned as a function).
        if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s+/.test(line)) continue;
        // Skip interface / type aliases.
        if (/^\s*(?:export\s+)?(?:interface|type)\s+/.test(line)) continue;
        // Skip control-flow statements explicitly.
        if (CONTROL_FLOW_RE.test(line)) continue;

        // Accumulate the declaration line — TypeScript parameter lists can
        // wrap across multiple lines. Stop accumulating when we either see
        // a `{` (function body) or a `;` / `=` (variable / field).
        let decl = line;
        let j = i;
        let openBraceFound = line.indexOf('{') !== -1;
        while (!openBraceFound && j + 1 < lines.length) {
            if (line.includes('=') && !line.includes('=>')) {
                decl = '';
                break;
            }
            if (line.includes(';')) {
                decl = '';
                break;
            }
            j += 1;
            const next = stripComments(lines[j]);
            decl += '\n' + next;
            if (next.indexOf('{') !== -1) openBraceFound = true;
        }
        if (!openBraceFound) continue;
        if (!decl) continue;

        // Reject control-flow statements that may have wrapped onto decl.
        if (CONTROL_FLOW_RE.test(decl)) continue;

        // Skip anonymous arrow functions (`() => { ... }` and `(args) => { ... }`).
        // These are always callbacks (e.g. `_gridLock.acquire(async () => { ... })`),
        // and the relevant function for the persistence invariant is the
        // outer named function that contains them, not the callback itself.
        const isAnonymousArrow = /=>\s*\{/.test(decl)
            && !/(?:async\s+)?function\s+/.test(decl)
            && !/^[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(decl.trim());
        if (isAnonymousArrow) continue;

        // Must be a real function: named, `function` keyword, getter/setter,
        // or arrow.
        const isFunction =
            FUNCTION_NAME_RE.test(decl) ||
            FUNCTION_KEYWORD_RE.test(decl) ||
            GETTER_SETTER_RE.test(decl) ||
            ARROW_RE.test(decl);
        if (!isFunction) continue;

        // Reject if the matched name is a built-in (e.g. `Error`, `Array`,
        // `String`) used in an expression like `throw new Error(...)`.
        // The function-name regex matches these too because the identifier
        // pattern is permissive.
        const fnNameMatch = decl.match(FUNCTION_NAME_RE);
        if (fnNameMatch && BUILTIN_NAMES.has(fnNameMatch[1])) {
            // Allow if preceded by `function` keyword (rare) or by
            // `async`/`static`/`export` modifier and the same name.
            if (!FUNCTION_KEYWORD_RE.test(decl) && !GETTER_SETTER_RE.test(decl)) {
                continue;
            }
        }

        // Extract the function name (best-effort).
        let name = '<anonymous>';
        const nameMatch =
            decl.match(/(?:async\s+)?(?:function\s+|[#.]?)([A-Za-z_$][\w$]*)\s*[(<]/)
            || decl.match(/(?:get|set)\s+([A-Za-z_$][\w$]*)/);
        if (nameMatch) {
            const candidate = nameMatch[1];
            // Defensive: control-flow keywords must never be reported as a
            // function name (the regex match above could still pick them up
            // if they appear later in the decl).
            if (candidate
                && !/^(if|for|while|switch|try|catch|do|else|class|interface|type|return)$/.test(candidate)
                && !BUILTIN_NAMES.has(candidate)) {
                name = candidate;
            }
        }

        // Locate the opening brace position in the accumulated decl.
        const openIdx = decl.indexOf('{');
        if (openIdx === -1) continue;

        // Indentation of the opening brace's line — the closing `}` of
        // the body must be at the same column. This prevents sibling
        // function declarations (whose `{` is at the same column as
        // ours, but whose `}` is at the same column too) from being
        // miscounted: we filter post-scan by column matching.
        const openLineRaw = lines[i] || '';
        const openLineIndentMatch = openLineRaw.match(/^(\s*)/);
        const bodyStartIndent = openLineIndentMatch ? openLineIndentMatch[1].length : 0;

        // Count braces from the opening brace forward, using the rest of
        // `decl` (for the first line) followed by the remaining source
        // lines. We must skip string / template / regex literals.
        let depth = 0;
        let parenDepth = 0;   // () and [] depth — used to ignore braces inside
                              //   object literals passed as function arguments
        let inString = null;   // '"' | "'" | '`'
        let inRegex = false;
        let inLineComment = false;
        let inBlockComment = false;
        let endLine = j;
        let ended = false;

        const scan = (text) => {
            for (let k = 0; k < text.length; k++) {
                const c = text[k];
                const next = text[k + 1];

                if (inLineComment) break;
                if (inBlockComment) {
                    if (c === '*' && next === '/') { inBlockComment = false; k++; }
                    continue;
                }
                if (inString) {
                    if (c === '\\') { k++; continue; }
                    if (c === inString) inString = null;
                    continue;
                }
                if (inRegex) {
                    if (c === '\\') { k++; continue; }
                    if (c === '/') inRegex = false;
                    continue;
                }
                if (c === '/' && next === '/') { inLineComment = true; break; }
                if (c === '/' && next === '*') { inBlockComment = true; k++; continue; }
                if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
                if (c === '/' && /[=([,;:!&|?{}>\n]/.test(text[k - 1] || '\n')) {
                    inRegex = true;
                    continue;
                }
                if (c === '(' || c === '[') { parenDepth++; continue; }
                if (c === ')' || c === ']') { parenDepth--; continue; }
                if (parenDepth !== 0) continue;
                if (c === '{') depth++;
                else if (c === '}') {
                    depth--;
                    if (depth === 0) { ended = true; return true; }
                }
            }
            return false;
        };

        // Scan the remainder of the declaration line first, then
        // subsequent lines.
        const rest = decl.slice(openIdx + 1);
        if (scan(rest)) {
            // Body closed on the same accumulated-decl lines.
        } else {
            for (let k = j + 1; k < lines.length; k++) {
                if (scan(lines[k])) { endLine = k; break; }
            }
            if (!ended) continue; // Malformed — skip rather than false-positive.
        }

        // Verify the closing `}` is at the same column as the opening
        // `{`. This rejects the case where the brace counter matched
        // a sibling function's opening/closing braces instead of the
        // current body's closer.
        const closeLine = lines[endLine] || '';
        const closeIndentMatch = closeLine.match(/^(\s*)/);
        const closeIndent = closeIndentMatch ? closeIndentMatch[1].length : 0;
        if (closeIndent !== bodyStartIndent) {
            // Re-scan: find the first line at bodyStartIndent whose only
            // non-whitespace content is `}`.
            let found = false;
            for (let k = j + 1; k < lines.length; k++) {
                const line = lines[k] || '';
                if (!line.trim()) continue;
                const lm = line.match(/^(\s*)/);
                const li = lm ? lm[1].length : 0;
                if (li === bodyStartIndent && line.trim() === '}') {
                    endLine = k;
                    found = true;
                    break;
                }
            }
            if (!found) continue; // Malformed — skip rather than false-positive.
        }

        bodies.push({ name, start: i, end: endLine, lineNo: i + 1 });
    }

    // Filter: keep only top-level function bodies. A body is top-level
    // if no earlier body contains its entire line range. This prevents
    // false positives where an identifier inside a function body
    // (e.g. `String(filledOrder.size)` in an array literal) is mistakenly
    // treated as a function declaration and absorbs the rest of the
    // enclosing function as its "body".
    const topLevel = bodies.filter((b, idx) => {
        for (let k = 0; k < idx; k++) {
            const other = bodies[k];
            if (other.start <= b.start && b.end <= other.end) {
                return false; // contained in a previously-detected body
            }
        }
        return true;
    });

    return topLevel;
}

/**
 * Test whether any line in `[start..end]` matches any regex in `patterns`.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 * @param {RegExp[]} patterns
 * @returns {boolean}
 */
function hasMatchInRange(lines, start, end, patterns) {
    for (let i = start; i <= end; i++) {
        const line = stripComments(lines[i]);
        for (const re of patterns) {
            if (re.test(line)) return true;
        }
    }
    return false;
}

// ----------------------------------------------------------------------------
// Directory walker
// ----------------------------------------------------------------------------

/**
 * Recursively walk `dir`, yielding absolute paths of files with one of
 * the configured extensions. Skip `node_modules` and `dist`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (_) {
        return out;
    }
    for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = path.join(dir, entry);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        if (stat.isDirectory()) {
            out.push(...walk(full));
        } else if (SCAN_EXTENSIONS.some(ext => entry.endsWith(ext))) {
            out.push(full);
        }
    }
    return out;
}

// ----------------------------------------------------------------------------
// Main scan
// ----------------------------------------------------------------------------

const violations = [];
let scannedFiles = 0;
let scannedFunctions = 0;

for (const baseDir of SCAN_DIRS) {
    const files = walk(baseDir);
    for (const file of files) {
        const rel = path.relative(path.join(__dirname, '..'), file);
        if (FILE_SKIP_LIST.has(path.basename(file).split('.')[0] + '_')) continue;
        if (path.basename(file).startsWith('test_')) continue;
        if (path.basename(file).startsWith('repro_')) continue;

        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
        const lines = content.split('\n');
        scannedFiles++;

        const bodies = findFunctionBodies(lines);
        scannedFunctions += bodies.length;

        for (const body of bodies) {
            if (WHITELIST_FUNCTIONS.has(body.name)) continue;

            const hasMutation = hasMatchInRange(lines, body.start, body.end, MUTATION_PATTERNS);
            if (!hasMutation) continue;

            const hasPersist = hasMatchInRange(lines, body.start, body.end, PERSIST_PATTERNS);
            if (hasPersist) continue;

            // Also check the immediate enclosing function (one level up) —
            // some helpers delegate the persistGrid to the caller. We do
            // this by finding the next function body in the same file that
            // starts after this body ends, and whose start line is before
            // any function call. For simplicity, just report the violation
            // and let the developer add the persistGrid() call OR add the
            // helper to WHITELIST_FUNCTIONS with a clear comment.

            violations.push({
                file: rel,
                line: body.lineNo,
                functionName: body.name,
                startLine: body.start + 1,
                endLine: body.end + 1
            });
        }
    }
}

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------

console.log('='.repeat(80));
console.log(`\nSCAN SUMMARY:\n  Files scanned: ${scannedFiles}\n  Functions scanned: ${scannedFunctions}\n  Violations: ${violations.length}\n`);

if (violations.length === 0) {
    console.log('✓ PASS — every function that mutates the master grid also persists it.\n');
    console.log('Invariant enforced:');
    console.log('  Any function that calls _updateOrder() / applyGridUpdateBatch()');
    console.log('  must also call persistGrid() or flushGridDirty() in the same body');
    console.log('  — directly, or via a documented WHITELIST_FUNCTIONS entry.\n');
    process.exit(0);
}

console.log('✗ VIOLATIONS FOUND:\n');
for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  function ${v.functionName}() [lines ${v.startLine}-${v.endLine}]`);
    console.log(`    → calls _updateOrder()/applyGridUpdateBatch() without a matching persistGrid()/flushGridDirty()`);
    console.log(`    FIX: add 'await this.manager.persistGrid();' (or flushGridDirty()) at the end of the function,`);
    console.log(`         or add '${v.functionName}' to WHITELIST_FUNCTIONS in tests/test_grid_persistence_guard.ts with a comment.`);
    console.log();
}

console.log('='.repeat(80));
console.log(`\nSTATUS: ✗ FAIL  (${violations.length} violation${violations.length === 1 ? '' : 's'})\n`);
process.exit(1);
