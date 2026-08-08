/**
 * tests/test_node_failover.ts - Integration tests for node failover behavior
 *
 * Tests integration scenarios:
 * - Multi-node configuration loading
 * - Automatic failover on node failure
 * - Configuration error handling
 * - Default fallback behavior
 */

const NodeManager = require('../modules/node_manager').default;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NODE_MANAGEMENT } = require('../modules/constants');

console.log('Testing Node Failover Integration...\n');

const tempStateDirs: any[] = [];

function createNodeManager(config = {}) {
    if ((config as any).stateDir) return new NodeManager(config);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-node-failover-test-'));
    tempStateDirs.push(stateDir);
    return new NodeManager({ ...config, stateDir });
}

process.on('exit', () => {
    for (const dir of tempStateDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================================
// Test 1: Configuration with Multiple Nodes
// ============================================================================
{
    console.log('Test 1: Multi-node configuration');
    const config = {
        list: ['wss://node1.com/ws', 'wss://node2.com/ws', 'wss://node3.com/ws'],
        healthCheck: {
            enabled: true,
            intervalMs: 30000,
            timeoutMs: 3000,
            maxPingMs: 2000,
            blacklistThreshold: 2
        },
        selection: {
            strategy: 'latency'
        }
    };

    const nm = createNodeManager(config);
    assert.strictEqual(nm.config.list.length, 3);
    assert.strictEqual(nm.config.healthCheck.enabled, true);
    assert.strictEqual(nm.config.healthCheck.intervalMs, 30000);
    assert.strictEqual(nm.config.healthCheck.blacklistThreshold, 2);
    console.log('✓ Multi-node configuration test passed\n');
}

// ============================================================================
// Test 2: Configuration with Default Values
// ============================================================================
{
    console.log('Test 2: Configuration with partial settings (defaults applied)');
    const config = {
        list: ['wss://node1.com/ws']
        // No healthCheck settings - should use defaults
    };

    const nm = createNodeManager(config);
    assert.strictEqual(nm.config.healthCheck.intervalMs, NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS, 'Should default to shared interval');
    assert.strictEqual(nm.config.healthCheck.timeoutMs, NODE_MANAGEMENT.HEALTH_CHECK_TIMEOUT_MS, 'Should default to shared timeout');
    assert.strictEqual(nm.config.healthCheck.maxPingMs, NODE_MANAGEMENT.MAX_PING_MS, 'Should default to shared max ping');
    assert.strictEqual(nm.config.healthCheck.blacklistThreshold, NODE_MANAGEMENT.BLACKLIST_THRESHOLD, 'Should default to shared threshold');
    console.log('✓ Default configuration test passed\n');
}

// ============================================================================
// Test 3: Failover Scenario - Current Node Dies
// ============================================================================
{
    console.log('Test 3: Failover when current best node fails');

    const nm = createNodeManager({
        list: ['primary', 'backup', 'tertiary']
    });

    // Setup initial node statuses
    nm.nodeStats.get('primary').status = 'healthy';
    nm.nodeStats.get('primary').latencyMs = 50;
    nm.nodeStats.get('backup').status = 'healthy';
    nm.nodeStats.get('backup').latencyMs = 200;
    nm.nodeStats.get('tertiary').status = 'blacklisted';

    // Primary is best node
    assert.strictEqual(nm.getBestNode(), 'primary');

    // Primary fails (simulating disconnection detection)
    nm.blacklistNode('primary');

    // Check that failover selects backup
    assert.strictEqual(nm.getBestNode(), 'backup', 'Should failover to backup');
    assert.strictEqual(nm.nodeStats.get('primary').status, 'blacklisted');
    console.log('✓ Failover scenario test passed\n');
}

// ============================================================================
// Test 4: Cascading Failover
// ============================================================================
{
    console.log('Test 4: Cascading failover through multiple nodes');

    const nm = createNodeManager({
        list: ['node1', 'node2', 'node3', 'node4']
    });

    // Setup nodes with different latencies
    nm.nodeStats.get('node1').status = 'healthy';
    nm.nodeStats.get('node1').latencyMs = 50;
    nm.nodeStats.get('node2').status = 'healthy';
    nm.nodeStats.get('node2').latencyMs = 100;
    nm.nodeStats.get('node3').status = 'healthy';
    nm.nodeStats.get('node3').latencyMs = 150;
    nm.nodeStats.get('node4').status = 'failed';

    // Initial best
    assert.strictEqual(nm.getBestNode(), 'node1');

    // node1 fails, should select node2
    nm.blacklistNode('node1');
    assert.strictEqual(nm.getBestNode(), 'node2');

    // node2 fails, should select node3
    nm.blacklistNode('node2');
    assert.strictEqual(nm.getBestNode(), 'node3');

    // node3 fails, should return null (no healthy nodes)
    nm.blacklistNode('node3');
    assert.strictEqual(nm.getBestNode(), null);

    console.log('✓ Cascading failover test passed\n');
}

// ============================================================================
// Test 5: Slow Node Fallback
// ============================================================================
{
    console.log('Test 5: Falling back to slow nodes when no healthy nodes');

    const nm = createNodeManager({
        list: ['healthy1', 'slow1', 'slow2']
    });

    nm.nodeStats.get('healthy1').status = 'healthy';
    nm.nodeStats.get('healthy1').latencyMs = 1000;
    nm.nodeStats.get('slow1').status = 'slow';
    nm.nodeStats.get('slow1').latencyMs = 4000;
    nm.nodeStats.get('slow2').status = 'slow';
    nm.nodeStats.get('slow2').latencyMs = 5000;

    // Best healthy should still be selected
    assert.strictEqual(nm.getBestNode(), 'healthy1');

    // Kill healthy node, should fall back to slow nodes
    nm.blacklistNode('healthy1');
    assert.strictEqual(nm.getBestNode(), 'slow1', 'Should select slow node with lower latency');

    const healthy = nm.getHealthyNodes();
    assert.strictEqual(healthy.length, 2, 'Should return both slow nodes');
    console.log('✓ Slow node fallback test passed\n');
}

// ============================================================================
// Test 6: All Nodes Down
// ============================================================================
{
    console.log('Test 6: Handling all nodes down scenario');

    const nm = createNodeManager({
        list: ['node1', 'node2', 'node3']
    });

    // Mark all as blacklisted
    for (const url of ['node1', 'node2', 'node3']) {
        nm.blacklistNode(url);
    }

    assert.strictEqual(nm.getBestNode(), null, 'Should return null when all down');
    assert.strictEqual(nm.getHealthyNodes().length, 0, 'Should return empty healthy list');

    const summary = nm.getSummary();
    assert.strictEqual(summary.counts.blacklisted, 3);
    assert.strictEqual(summary.counts.healthy, 0);
    console.log('✓ All nodes down test passed\n');
}

// ============================================================================
// Test 7: Node Recovery After Blacklisting
// ============================================================================
{
    console.log('Test 7: Node recovery after being blacklisted');

    const nm = createNodeManager({
        list: ['node1', 'node2']
    });

    nm.nodeStats.get('node1').status = 'healthy';
    nm.nodeStats.get('node1').latencyMs = 100;
    nm.nodeStats.get('node2').status = 'healthy';
    nm.nodeStats.get('node2').latencyMs = 200;

    // Blacklist node1
    nm.blacklistNode('node1');
    assert.strictEqual(nm.getBestNode(), 'node2');

    // Later, reset node1 and simulate successful health check
    nm.resetNode('node1');
    nm.nodeStats.get('node1').status = 'healthy';
    nm.nodeStats.get('node1').latencyMs = 80; // Now faster than node2

    assert.strictEqual(nm.getBestNode(), 'node1', 'Should select recovered node if it\'s now fastest');
    console.log('✓ Node recovery test passed\n');
}

// ============================================================================
// Test 8: Configuration Validation
// ============================================================================
{
    console.log('Test 8: Configuration validation');

    // Empty list should work (but with no nodes)
    const nm1 = createNodeManager({ list: [] });
    assert.strictEqual(nm1.config.list.length, 0);
    assert.strictEqual(nm1.getBestNode(), null);

    // Single node
    const nm2 = createNodeManager({ list: ['wss://only-node.com/ws'] });
    assert.strictEqual(nm2.config.list.length, 1);

    // Very large list
    const manyNodes = Array.from({ length: 100 }, (_, i) => `wss://node${i}.com/ws`);
    const nm3 = createNodeManager({ list: manyNodes });
    assert.strictEqual(nm3.config.list.length, 100);

    console.log('✓ Configuration validation test passed\n');
}

// ============================================================================
// Test 9: Monitoring State Transitions
// ============================================================================
{
    console.log('Test 9: Monitoring state transitions');

    const nm = createNodeManager({
        list: ['node1']
    });

    // Start monitoring
    nm.start();
    assert.strictEqual(nm.monitoringActive, true);
    assert(nm.checkIntervalId !== null, 'Should have interval ID');

    // Stop monitoring
    nm.stop();
    assert.strictEqual(nm.monitoringActive, false);
    assert.strictEqual(nm.checkIntervalId, null);

    // Can restart after stop
    nm.start();
    assert.strictEqual(nm.monitoringActive, true);

    nm.stop();
    console.log('✓ Monitoring state transitions test passed\n');
}

// ============================================================================
// Test 10: Health Check Timeout Configuration
// ============================================================================
{
    console.log('Test 10: Health check timeout configuration');

    const config1 = {
        list: ['node1'],
        healthCheck: {
            timeoutMs: 2000  // Short timeout
        }
    };

    const nm1 = createNodeManager(config1);
    assert.strictEqual(nm1.config.healthCheck.timeoutMs, 2000);

    const config2 = {
        list: ['node1'],
        healthCheck: {
            timeoutMs: 10000  // Long timeout
        }
    };

    const nm2 = createNodeManager(config2);
    assert.strictEqual(nm2.config.healthCheck.timeoutMs, 10000);

    console.log('✓ Health check timeout configuration test passed\n');
}

// ============================================================================
// Test 11: Latency Comparison and Sorting
// ============================================================================
{
    console.log('Test 11: Complex latency sorting');

    const nm = createNodeManager({
        list: ['a', 'b', 'c', 'd', 'e']
    });

    // Set mixed statuses and latencies
    nm.nodeStats.get('a').status = 'healthy';
    nm.nodeStats.get('a').latencyMs = 500;
    nm.nodeStats.get('b').status = 'healthy';
    nm.nodeStats.get('b').latencyMs = 100; // Lowest
    nm.nodeStats.get('c').status = 'slow';
    nm.nodeStats.get('c').latencyMs = 200;
    nm.nodeStats.get('d').status = 'slow';
    nm.nodeStats.get('d').latencyMs = 150; // Lowest among slow
    nm.nodeStats.get('e').status = 'blacklisted';

    const healthy = nm.getHealthyNodes();
    assert.strictEqual(healthy.length, 4);
    assert.strictEqual(healthy[0], 'b', 'Lowest latency healthy first');
    assert.strictEqual(healthy[1], 'a', 'Next healthy');
    assert.strictEqual(healthy[2], 'd', 'Lowest latency slow');
    assert.strictEqual(healthy[3], 'c', 'Higher latency slow');
    console.log('✓ Complex latency sorting test passed\n');
}

// ============================================================================
// Test 12: Statistics Persistence Across Operations
// ============================================================================
{
    console.log('Test 12: Statistics persistence');

    const nm = createNodeManager({
        list: ['node1', 'node2']
    });

    nm.nodeStats.get('node1').status = 'healthy';
    nm.nodeStats.get('node1').latencyMs = 100;
    nm.nodeStats.get('node1').lastCheckTime = '2026-02-05T10:00:00Z';
    nm.nodeStats.get('node1').chainId = '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8';

    // Get stats multiple times - should be consistent
    const stats1 = nm.getStats();
    const stats2 = nm.getStats();

    assert.strictEqual(stats1[0].status, stats2[0].status);
    assert.strictEqual(stats1[0].latencyMs, stats2[0].latencyMs);
    assert.strictEqual(stats1[0].lastCheckTime, stats2[0].lastCheckTime);

    console.log('✓ Statistics persistence test passed\n');
}

console.log('='.repeat(60));
console.log('All Node Failover integration tests passed!');
console.log('='.repeat(60));
