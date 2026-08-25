#!/usr/bin/env node
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const tscCacheDir = join(rootDir, 'node_modules', '.cache');

rmSync(distDir, { recursive: true, force: true });

// Incremental tsbuildinfo files live outside dist/, so a stale cache would
// make the next `tsc` believe everything is up to date and emit nothing.
for (const info of ['tsc-prod.tsbuildinfo', 'tsc-tests.tsbuildinfo', 'tsc-claw.tsbuildinfo']) {
    rmSync(join(tscCacheDir, info), { force: true });
}
