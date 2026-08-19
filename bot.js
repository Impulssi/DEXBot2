#!/usr/bin/env node
// Shim: runs compiled dist/bot.js
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const distTarget = join(__dirname, 'dist', 'bot.js');
if (!existsSync(distTarget)) {
  console.error('dist/bot.js not found. Run `npm run build` first.');
  process.exit(1);
}
await import(distTarget);