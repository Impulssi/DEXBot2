#!/usr/bin/env node
// Shim: runs compiled dist/credential-daemon.js
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const distTarget = join(__dirname, 'dist', 'credential-daemon.js');
if (!existsSync(distTarget)) {
  console.error('dist/credential-daemon.js not found. Run `npm run build` first.');
  process.exit(1);
}
await import(distTarget);