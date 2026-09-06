'use strict';

// Offline tests for the process-wide Logger console floor:
// direct-output methods (grid, rows, status tables) must honor it exactly
// like log() does, and output must return fully after restore.

const assert = require('assert');
const { createPm2AwareLogger, setGlobalConsoleLevel } = require('../modules/order/logger');

function captureLog(fn: () => void): string[] {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: any[]) => { lines.push(a.join(' ')); };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function testFloorGatesDirectOutput() {
  const logger = createPm2AwareLogger('floor-test', { level: 'debug' });
  const orders = [{ price: 1, id: '1.7.1', type: 'buy', state: 'active', size: 1 }];
  const shown = captureLog(() => logger.logOrderGrid(orders, 1));
  assert.ok(shown.length > 0, 'grid must print without a floor');
  setGlobalConsoleLevel('warn');
  try {
    assert.strictEqual(captureLog(() => logger.logOrderGrid(orders, 1)).length, 0, 'grid must be muted under a warn floor');
    assert.strictEqual(captureLog(() => logger._logOrderRow(orders[0])).length, 0, 'order rows must be muted under a warn floor');
    assert.strictEqual(captureLog(() => logger.displayStatus(null)).length, 0, 'status must stay silent (null manager)');
  } finally {
    setGlobalConsoleLevel(null);
  }
  assert.ok(captureLog(() => logger._logOrderRow(orders[0])).length > 0, 'output must return after floor restore');
}

function testWarnStillPassesWarnFloor() {
  const logger = createPm2AwareLogger('floor-test', { level: 'debug' });
  setGlobalConsoleLevel('warn');
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    logger.log('attention', 'warn');
  } finally {
    console.warn = origWarn;
    setGlobalConsoleLevel(null);
  }
  assert.strictEqual(warned, 1, 'warn must pass a warn floor');
}

async function main() {
  testFloorGatesDirectOutput();
  testWarnStillPassesWarnFloor();
  console.log('logger console floor tests passed');
}

main().catch((err) => {
  console.error('logger console floor tests FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
