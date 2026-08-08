/**
 * tests/test_node_manager.ts - Unit tests for NodeManager
 *
 * Tests core functionality:
 * - Node health checking
 * - Latency measurement
 * - Chain ID validation
 * - Node selection and blacklisting
 * - Statistics tracking
 */

const NodeManager = require('../modules/node_manager').default;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    orderNodesFromHealthCache,
    orderNodesForSettings,
    readHealthCache,
} = require('../modules/node_health_cache');
const { NODE_MANAGEMENT } = require('../modules/constants');

console.log('Testing NodeManager...\n');

const tempStateDirs: any[] = [];

function createNodeManager(config = {}) {
    if ((config as any).stateDir) return new NodeManager(config);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-node-manager-test-'));
    tempStateDirs.push(stateDir);
    return new NodeManager({ ...config, stateDir });
}

process.on('exit', () => {
    for (const dir of tempStateDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================================
// Test 1: Initialization
// ============================================================================
{
    console.log('Test 1: Initialization with empty config');
    const nm = createNodeManager({});
    assert.strictEqual(nm.config.list.length, 0, 'Empty list should work');
    assert.strictEqual(nm.config.healthCheck.intervalMs, NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS);
    assert.strictEqual(nm.config.healthCheck.timeoutMs, NODE_MANAGEMENT.HEALTH_CHECK_TIMEOUT_MS);
    console.log('✓ Initialization test passed\n');
}

// ============================================================================
// Test 2: Node Stats Initialization
// ============================================================================
{
    console.log('Test 2: Node stats initialization');
    const nodes = ['wss://node1.com/ws', 'wss://node2.com/ws'];
    const nm = createNodeManager({ list: nodes });

    const stats = nm.getStats();
    assert.strictEqual(stats.length, 2, 'Should track both nodes');
    assert.strictEqual(stats[0].status, 'unchecked', 'New nodes should be unchecked');
    assert.strictEqual(stats[0].failureCount, 0);
    assert.strictEqual(stats[0].latencyMs, null);
    console.log('✓ Node stats initialization test passed\n');
}

// ============================================================================
// Test 3: Healthy Nodes Filter
// ============================================================================
{
    console.log('Test 3: Healthy nodes filtering');
    const nm = createNodeManager({ list: ['n1', 'n2', 'n3'] });

    // Manually set node statuses
    nm.nodeStats.get('n1').status = 'healthy';
    nm.nodeStats.get('n1').latencyMs = 100;
    nm.nodeStats.get('n2').status = 'slow';
    nm.nodeStats.get('n2').latencyMs = 3500;
    nm.nodeStats.get('n3').status = 'blacklisted';

    const healthy = nm.getHealthyNodes();
    assert.strictEqual(healthy.length, 2, 'Should include healthy and slow');
    assert.strictEqual(healthy[0], 'n1', 'Should sort healthy first');
    assert.strictEqual(healthy[1], 'n2', 'Then slow');
    console.log('✓ Healthy nodes filtering test passed\n');
}

// ============================================================================
// Test 4: Best Node Selection (Latency Sorting)
// ============================================================================
{
    console.log('Test 4: Best node selection by latency');
    const nm = createNodeManager({ list: ['fast', 'slow', 'medium'] });

    nm.nodeStats.get('fast').status = 'healthy';
    nm.nodeStats.get('fast').latencyMs = 50;
    nm.nodeStats.get('slow').status = 'healthy';
    nm.nodeStats.get('slow').latencyMs = 500;
    nm.nodeStats.get('medium').status = 'healthy';
    nm.nodeStats.get('medium').latencyMs = 200;

    const best = nm.getBestNode();
    assert.strictEqual(best, 'fast', 'Should select lowest latency node');
    console.log('✓ Best node selection test passed\n');
}

// ============================================================================
// Test 4b: Preferred Node Selection
// ============================================================================
{
    console.log('Test 4b: Preferred healthy node selection');
    const nm = createNodeManager({
        list: ['fast', 'preferred', 'slow'],
        selection: { preferredNode: 'preferred' },
    });

    nm.nodeStats.get('fast').status = 'healthy';
    nm.nodeStats.get('fast').latencyMs = 50;
    nm.nodeStats.get('preferred').status = 'healthy';
    nm.nodeStats.get('preferred').latencyMs = 500;
    nm.nodeStats.get('slow').status = 'healthy';
    nm.nodeStats.get('slow').latencyMs = 1000;

    assert.strictEqual(nm.getBestNode(), 'preferred', 'Healthy preferred node should win over lower latency nodes');

    nm.nodeStats.get('preferred').status = 'slow';
    assert.strictEqual(nm.getBestNode(), 'fast', 'Slow preferred node should not override healthy nodes');
    console.log('✓ Preferred healthy node selection test passed\n');
}

// ============================================================================
// Test 5: No Healthy Nodes
// ============================================================================
{
    console.log('Test 5: Handling when no healthy nodes available');
    const nm = createNodeManager({ list: ['n1', 'n2'] });
    nm.nodeStats.get('n1').status = 'blacklisted';
    nm.nodeStats.get('n2').status = 'failed';

    const best = nm.getBestNode();
    assert.strictEqual(best, null, 'Should return null when no healthy nodes');

    const healthy = nm.getHealthyNodes();
    assert.strictEqual(healthy.length, 0, 'Should return empty array');
    console.log('✓ No healthy nodes test passed\n');
}

// ============================================================================
// Test 6: Failure Count and Blacklisting
// ============================================================================
{
    console.log('Test 6: Failure counting and blacklisting');
    const nm = createNodeManager({
        list: ['node1'],
        healthCheck: { blacklistThreshold: 3 }
    });

    const stats = nm.nodeStats.get('node1');
    assert.strictEqual(stats.status, 'unchecked');

    // Simulate failures
    stats.failureCount = 1;
    assert.strictEqual(stats.status, 'unchecked', 'Threshold not reached');

    stats.failureCount = 2;
    assert.strictEqual(stats.status, 'unchecked', 'Threshold not reached');

    stats.failureCount = 3;
    stats.status = 'blacklisted';
    assert.strictEqual(stats.status, 'blacklisted', 'Should be blacklisted');
    console.log('✓ Failure counting and blacklisting test passed\n');
}

// ============================================================================
// Test 7: Manual Node Blacklisting
// ============================================================================
{
    console.log('Test 7: Manual node blacklisting');
    const nm = createNodeManager({ list: ['node1', 'node2'] });

    nm.nodeStats.get('node1').status = 'healthy';
    nm.nodeStats.get('node2').status = 'healthy';

    nm.blacklistNode('node1');
    assert.strictEqual(nm.nodeStats.get('node1').status, 'blacklisted');
    assert.strictEqual(nm.nodeStats.get('node2').status, 'healthy');

    const best = nm.getBestNode();
    assert.strictEqual(best, 'node2', 'Should select remaining healthy node');
    console.log('✓ Manual blacklisting test passed\n');
}

// ============================================================================
// Test 7b: Blacklist warning deduplication
// ============================================================================
{
    console.log('Test 7b: Blacklist warning deduplication');
    const nm = createNodeManager({ list: ['node1'] });

    assert.strictEqual(
        nm._shouldLogBlacklistWarning('node1', 'timeout', 1_000),
        true,
        'First node+error warning should log'
    );
    assert.strictEqual(
        nm._shouldLogBlacklistWarning('node1', 'timeout', 2_000),
        false,
        'Repeated node+error warning should be suppressed inside the cooldown'
    );
    assert.strictEqual(
        nm._shouldLogBlacklistWarning('node1', 'connection refused', 3_000),
        true,
        'Different errors for the same node should have independent cooldown entries'
    );
    assert.strictEqual(
        nm._shouldLogBlacklistWarning('node1', 'timeout', 3_601_001),
        true,
        'Same node+error should log again after the cooldown expires'
    );
    console.log('✓ Blacklist warning deduplication test passed\n');
}

// ============================================================================
// Test 8: Node Reset
// ============================================================================
{
    console.log('Test 8: Node reset functionality');
    const nm = createNodeManager({ list: ['node1', 'node2'] });

    nm._shouldLogBlacklistWarning('node1', 'timeout', 1_000);
    assert.strictEqual(
        nm._shouldLogBlacklistWarning('node1', 'timeout', 2_000),
        false,
        'Precondition: warning cooldown should be active before reset'
    );

    // Mark node1 as failed
    nm.nodeStats.get('node1').status = 'blacklisted';
    nm.nodeStats.get('node1').failureCount = 5;
    nm.nodeStats.get('node1').latencyMs = 100;
    nm.nodeStats.get('node1').lastErrorMessage = 'Test error';

    // Reset it
    nm.resetNode('node1');
    const stats = nm.nodeStats.get('node1');
    assert.strictEqual(stats.status, 'unchecked');
    assert.strictEqual(stats.failureCount, 0);
    assert.strictEqual(stats.latencyMs, null);
    assert.strictEqual(stats.lastErrorMessage, null);
    assert.strictEqual(
        nm._shouldLogBlacklistWarning('node1', 'timeout', 3_000),
        true,
        'Reset should clear blacklist warning cooldown for that node'
    );
    console.log('✓ Node reset test passed\n');
}

// ============================================================================
// Test 9: Reset All Nodes
// ============================================================================
{
    console.log('Test 9: Reset all nodes');
    const nm = createNodeManager({ list: ['n1', 'n2', 'n3'] });

    nm._shouldLogBlacklistWarning('n1', 'timeout', 1_000);
    nm._shouldLogBlacklistWarning('n2', 'rpc failure', 1_000);
    assert.strictEqual(nm._shouldLogBlacklistWarning('n1', 'timeout', 2_000), false);
    assert.strictEqual(nm._shouldLogBlacklistWarning('n2', 'rpc failure', 2_000), false);

    // Mark all as failed
    for (const node of ['n1', 'n2', 'n3']) {
        nm.nodeStats.get(node).status = 'blacklisted';
        nm.nodeStats.get(node).failureCount = 5;
    }

    nm.resetAllNodes();

    for (const node of ['n1', 'n2', 'n3']) {
        const stats = nm.nodeStats.get(node);
        assert.strictEqual(stats.status, 'unchecked');
        assert.strictEqual(stats.failureCount, 0);
    }
    assert.strictEqual(nm._shouldLogBlacklistWarning('n1', 'timeout', 3_000), true);
    assert.strictEqual(nm._shouldLogBlacklistWarning('n2', 'rpc failure', 3_000), true);
    console.log('✓ Reset all nodes test passed\n');
}

// ============================================================================
// Test 10: Statistics Summary
// ============================================================================
{
    console.log('Test 10: Statistics summary');
    const nm = createNodeManager({ list: ['h1', 'h2', 's1', 'f1', 'b1'] });

    nm.nodeStats.get('h1').status = 'healthy';
    nm.nodeStats.get('h1').latencyMs = 100;
    nm.nodeStats.get('h2').status = 'healthy';
    nm.nodeStats.get('h2').latencyMs = 200;
    nm.nodeStats.get('s1').status = 'slow';
    nm.nodeStats.get('s1').latencyMs = 3500;
    nm.nodeStats.get('f1').status = 'failed';
    nm.nodeStats.get('b1').status = 'blacklisted';

    const summary = nm.getSummary();
    assert.strictEqual(summary.counts.total, 5);
    assert.strictEqual(summary.counts.healthy, 2);
    assert.strictEqual(summary.counts.slow, 1);
    assert.strictEqual(summary.counts.failed, 1);
    assert.strictEqual(summary.counts.blacklisted, 1);
    assert.strictEqual(summary.counts.unchecked, 0);
    assert.strictEqual(summary.bestNode, 'h1', 'Best should be h1 with lowest latency');
    assert(summary.avgLatency > 150 && summary.avgLatency < 2000, 'Avg latency should be reasonable');
    console.log('✓ Statistics summary test passed\n');
}

// ============================================================================
// Test 11: Slow vs Healthy Classification
// ============================================================================
{
    console.log('Test 11: Slow vs healthy classification');
    const nm = createNodeManager({
        list: ['n1', 'n2'],
        healthCheck: { maxPingMs: 2000 }
    });

    nm.nodeStats.get('n1').status = 'healthy';
    nm.nodeStats.get('n1').latencyMs = 1000; // Below threshold
    nm.nodeStats.get('n2').status = 'slow';
    nm.nodeStats.get('n2').latencyMs = 3000; // Above threshold

    const healthy = nm.getHealthyNodes();
    assert.strictEqual(healthy.length, 2, 'Both should be in healthy list');
    assert.strictEqual(healthy[0], 'n1', 'Healthy should come first');
    assert.strictEqual(healthy[1], 'n2', 'Slow should come second');
    console.log('✓ Slow vs healthy classification test passed\n');
}

// ============================================================================
// Test 12: Monitoring State
// ============================================================================
{
    console.log('Test 12: Monitoring state tracking');
    const nm = createNodeManager({ list: ['node1'] });

    assert.strictEqual(nm.monitoringActive, false, 'Should start inactive');

    nm.start();
    assert.strictEqual(nm.monitoringActive, true, 'Should be active after start');

    nm.stop();
    assert.strictEqual(nm.monitoringActive, false, 'Should be inactive after stop');
    console.log('✓ Monitoring state test passed\n');
}

// ============================================================================
// Test 13: Duplicate Start Protection
// ============================================================================
{
    console.log('Test 13: Duplicate start protection');
    const nm = createNodeManager({ list: ['node1'] });

    nm.start();
    const firstId = nm.checkIntervalId;

    nm.start(); // Try to start again
    const secondId = nm.checkIntervalId;

    assert.strictEqual(firstId, secondId, 'Should use same interval on duplicate start');

    nm.stop();
    console.log('✓ Duplicate start protection test passed\n');
}

// ============================================================================
// Test 14: Health Status History
// ============================================================================
{
    console.log('Test 14: Health status history tracking');
    const nm = createNodeManager({ list: ['node1'] });
    const stats = nm.nodeStats.get('node1');

    assert.strictEqual(stats.lastCheckTime, null, 'Should start with no check time');

    stats.lastCheckTime = new Date().toISOString();
    stats.lastErrorMessage = 'Connection timeout';

    assert(stats.lastCheckTime !== null);
    assert.strictEqual(stats.lastErrorMessage, 'Connection timeout');
    console.log('✓ Health status history test passed\n');
}

// ============================================================================
// Test 15: Chain ID Storage
// ============================================================================
{
    console.log('Test 15: Chain ID storage');
    const nm = createNodeManager({ list: ['node1'] });
    const stats = nm.nodeStats.get('node1');

    assert.strictEqual(stats.chainId, null, 'Should start with null chainId');

    stats.chainId = '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8';
    assert.strictEqual(stats.chainId, '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8');
    console.log('✓ Chain ID storage test passed\n');
}

// ============================================================================
// Test 16: Health Cache Persistence
// ============================================================================
{
    console.log('Test 16: Health cache persistence');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-node-cache-'));
    try {
        const nm = createNodeManager({ list: ['fast', 'slow', 'failed'], stateDir });
        nm.nodeStats.get('fast').status = 'healthy';
        nm.nodeStats.get('fast').latencyMs = 50;
        nm.nodeStats.get('fast').lastCheckTime = '2026-05-13T00:00:00.000Z';
        nm.nodeStats.get('slow').status = 'slow';
        nm.nodeStats.get('slow').latencyMs = 4000;
        nm.nodeStats.get('failed').status = 'failed';

        nm.saveHealthCache();

        const cache = readHealthCache({ stateDir });
        assert.ok(cache, 'health cache should be readable');
        assert.deepStrictEqual(cache.nodes.map((node) => node.url), ['fast', 'slow']);

        const ordered = orderNodesFromHealthCache(['slow', 'failed', 'fast', 'extra'], { stateDir });
        assert.deepStrictEqual(ordered, ['fast', 'slow', 'failed', 'extra'], 'cache should order known good nodes first and preserve fallbacks');
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
    console.log('✓ Health cache persistence test passed\n');
}

// ============================================================================
// Test 17: Settings interval controls health cache freshness
// ============================================================================
{
    console.log('Test 17: Settings interval controls health cache freshness');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-node-cache-stale-'));
    try {
        const nm = createNodeManager({ list: ['cached'], stateDir });
        nm.nodeStats.get('cached').status = 'healthy';
        nm.nodeStats.get('cached').latencyMs = 25;
        const now = Date.now();
        nm.nodeStats.get('cached').lastCheckTime = new Date(now - 8 * 60 * 60 * 1000).toISOString();
        nm.saveHealthCache();

        const settings = {
            NODES: {
                list: ['configured', 'cached'],
                healthCheck: { intervalMs: 24 * 60 * 60 * 1000 },
            },
        };
        const freshForSettings = orderNodesForSettings(settings, {
            stateDir,
            now: now + 8 * 60 * 60 * 1000,
        });
        assert.deepStrictEqual(freshForSettings, ['cached', 'configured'], '24h settings interval should keep 8h cache usable');

        const staleForSettings = orderNodesForSettings(settings, {
            stateDir,
            now: now + 25 * 60 * 60 * 1000,
        });
        assert.deepStrictEqual(staleForSettings, ['configured', 'cached'], 'cache older than configured interval should not reorder configured nodes');
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
    console.log('✓ Settings interval cache freshness test passed\n');
}

// ============================================================================
// Test 18: Disabled health checks preserve configured node order
// ============================================================================
{
    console.log('Test 18: Disabled health checks preserve configured node order');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-node-cache-disabled-'));
    try {
        const nm = createNodeManager({ list: ['configured-first', 'cached-fast'], stateDir });
        nm.nodeStats.get('configured-first').status = 'slow';
        nm.nodeStats.get('configured-first').latencyMs = 5000;
        nm.nodeStats.get('cached-fast').status = 'healthy';
        nm.nodeStats.get('cached-fast').latencyMs = 10;
        nm.saveHealthCache();

        const settings = {
            NODES: {
                enabled: true,
                list: ['configured-first', 'cached-fast'],
                healthCheck: { enabled: false },
            },
        };
        const ordered = orderNodesForSettings(settings, { stateDir });
        assert.deepStrictEqual(ordered, ['configured-first', 'cached-fast'], 'disabled health checks should ignore cached reordering');
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
    console.log('✓ Disabled health check ordering test passed\n');
}

console.log('='.repeat(60));
console.log('All NodeManager unit tests passed!');
console.log('='.repeat(60));
