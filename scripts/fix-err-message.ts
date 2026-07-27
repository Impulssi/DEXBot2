#!/usr/bin/env node
/**
 * Fix unsafe getErrorMessage(err) usage in catch blocks across the codebase.
 *
 * Replaces direct `.message` access on caught error variables with
 * safe `getErrorMessage(err)` calls, and adds the import where needed.
 *
 * Usage: tsx scripts/fix-err-message.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Files to exclude (already clean or not applicable)
const EXCLUDE = new Set([
  'modules/utils/errors.ts',
  'modules/env.ts',
  'market_adapter/lp_chart_core.ts', // already safe with `err && err.message` pattern
  // test files use their own patterns
]);

function findCatchVariableNames(content: string): Set<string> {
  // Match catch(X: any), catch(X), catch (X) etc.
  const catchVarRe = /catch\s*\(\s*(\w+)\s*(?::\s*\w+)?\s*\)/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = catchVarRe.exec(content)) !== null) {
    names.add(m[1]);
  }
  return names;
}

function hasGetErrorMessageImport(content: string): boolean {
  // Check for an actual import/require of getErrorMessage, not just usage
  return /(?:import\s+\{[^}]*\bgetErrorMessage\b[^}]*\}|require\([^)]*errors[^)]*\))/.test(content) &&
         /getErrorMessage/.test(content);
}

function hasGetErrorMessageUsage(content: string): boolean {
  return /\bgetErrorMessage\s*\(/.test(content);
}

function needsGetErrorMessage(content: string, names: Set<string>): boolean {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Check if any .message access exists for this catch variable
    const re = new RegExp(`${escaped}\\.message`, 'g');
    if (re.test(content)) return true;
  }
  return false;
}

function addGetErrorMessageImport(content: string, relPath: string): string {
  const errorsRel = path.posix.relative(
    path.posix.dirname(relPath),
    'modules/utils/errors'
  );
  const errorsPath = errorsRel.startsWith('.') ? errorsRel : './' + errorsRel;

  // Detect if file uses ESM imports (prefer ESM style if any import exists)
  const hasImport = /^import\s/m.test(content);

  if (hasImport) {
    // ESM style
    const importLine = `import { getErrorMessage } from '${errorsPath}';`;
    // Find the last complete import statement (line with `from '...'` or `from "..."` ending with ;)
    const lines = content.split('\n');
    let lastImportEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/from\s+['"]/.test(lines[i]) && lines[i].trim().endsWith(';')) {
        lastImportEnd = i;
      }
    }
    if (lastImportEnd >= 0) {
      lines.splice(lastImportEnd + 1, 0, importLine);
      return lines.join('\n');
    }
    return importLine + '\n' + content;
  } else {
    // CJS style — find the last top-level require (not inside a function/block)
    const importLine = `const { getErrorMessage } = require('${errorsPath}');`;
    const lines = content.split('\n');
    let insertAt = 0;

    // Track brace depth to skip requires inside function/blocks
    let braceDepth = 0;
    let lastRequireAtDepth0 = -1;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      const stripped = trimmed.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const openCount = (stripped.match(/\{/g) || []).length;
      const closeCount = (stripped.match(/\}/g) || []).length;

      // If this is a require() call at depth 0, track it
      if (braceDepth === 0 && /^(?:const|let|var)\s/.test(trimmed) && /require\(/.test(trimmed)) {
        lastRequireAtDepth0 = i;
      }

      braceDepth += openCount - closeCount;

      // Stop scanning for requires if brace depth went negative (ES module boundary)
      // or if we've clearly moved past the import section into runtime code
      // that's not itself a require
      if (braceDepth < 0) braceDepth = 0;
    }

    if (lastRequireAtDepth0 >= 0) {
      insertAt = lastRequireAtDepth0 + 1;
    } else {
      // Fallback: find first non-comment line
      for (let i = 0; i < Math.min(lines.length, 40); i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('#!/') || trimmed.startsWith("'use strict") || trimmed === '' ||
            trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) {
          insertAt = i + 1;
        } else break;
      }
    }

    lines.splice(insertAt, 0, importLine);
    return lines.join('\n');
  }
}

function fixContent(content: string, names: Set<string>): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Skip if already wrapped in getErrorMessage(...)
    // Pattern 1: `${name}.message` → `${getErrorMessage(name)}`
    // Match only when NOT already inside getErrorMessage(...)
    const templateRe = new RegExp(
      `\\$\\{${escaped}\\.message\\}`,
      'g'
    );
    content = content.replace(templateRe, `\${getErrorMessage(${name})}`);

    // Pattern 2: `name.message` → `getErrorMessage(name)`
    // Only replace when NOT already preceded by getErrorMessage(
    const directRe = new RegExp(
      `(?<!getErrorMessage\\()\\b${escaped}\\.message\\b`,
      'g'
    );
    content = content.replace(directRe, `getErrorMessage(${name})`);
  }
  return content;
}

function processFile(filePath: string): boolean {
  const relPath = path.relative(ROOT, filePath);
  if (EXCLUDE.has(relPath)) return false;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  const catchNames = findCatchVariableNames(content);
  if (catchNames.size === 0) return false;

  if (!needsGetErrorMessage(content, catchNames)) return false;

  // Fix .message accesses
  const fixed = fixContent(content, catchNames);
  const afterFixHasImport = hasGetErrorMessageImport(fixed);
  const afterFixHasUsage = hasGetErrorMessageUsage(fixed);

  // Add import if there's usage but no import
  let result = fixed;
  if (afterFixHasUsage && !afterFixHasImport) {
    result = addGetErrorMessageImport(result, relPath);
  }

  if (result !== content) {
    writeFileSync(filePath, result, 'utf-8');
    return true;
  }
  return false;
}

// Gather all .ts files
const tsFiles = [
  ...globSync('modules/**/*.ts', { cwd: ROOT }),
  ...globSync('market_adapter/**/*.ts', { cwd: ROOT }),
  ...globSync('scripts/*.ts', { cwd: ROOT }),
  ...globSync('claw/modules/**/*.ts', { cwd: ROOT }),
  ...globSync('claw/scripts/*.ts', { cwd: ROOT }),
  ...globSync('*.ts', { cwd: ROOT }),
  // tests
  ...globSync('tests/*.ts', { cwd: ROOT }),
  ...globSync('claw/tests/*.ts', { cwd: ROOT }),
];

let changed = 0;
let skipped = 0;

for (const file of tsFiles) {
  const fullPath = path.join(ROOT, file);
  if (!existsSync(fullPath)) continue;
  try {
    if (processFile(fullPath)) {
      console.log(`✓ ${file}`);
      changed++;
    } else {
      skipped++;
    }
  } catch (err: any) {
    console.error(`✗ ${file}: ${err?.message || err}`);
  }
}

console.log(`\nDone: ${changed} files modified, ${skipped} files skipped.`);
