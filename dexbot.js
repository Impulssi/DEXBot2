#!/usr/bin/env node
// Shim: prefers dist/dexbot.js, falls back to tsx for direct TS execution
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const distTarget = join(__dirname, 'dist', 'dexbot.js');
if (existsSync(distTarget)) {
  await import(distTarget);
} else {
  await import('tsx');
  await import('./dexbot.ts');
}