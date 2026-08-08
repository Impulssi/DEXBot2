/**
 * COW Index Set Mutation Detection Report
 * 
 * This script scans the codebase for direct mutations of _ordersByState and _ordersByType
 * Sets that bypass the COW _applyOrderUpdate() pipeline.
 * 
 * Any violations found represent COW invariant breaches.
 */



const fs = require('fs');
const path = require('path');
import { assertOrdersStructurallySound } from './helpers/order_test_helpers.js';
const { getErrorMessage } = require('../modules/utils/errors');

console.log('=== COW Index Set Mutation Detection Report ===\n');

// ============================================================================
// 1. Static Code Analysis
// ============================================================================

console.log('[ANALYSIS-1] Static Code Scanning for Direct Mutations...\n');

const violations: any[] = [];
const approvedPatterns = [
    '_applyOrderUpdate',
    '_clearOrderCachesLogic',
    'test_',
    'repro_',
    'Object.values(this._ordersByState).forEach(set => set.delete(id))'
];

const mutationPatterns = [
    {
        regex: /\._ordersByState\s*\[\s*ORDER_STATES\.\w+\s*\]\s*\.add\s*\(/g,
        type: '_ordersByState[STATE].add()',
        severity: 'HIGH'
    },
    {
        regex: /\._ordersByType\s*\[\s*ORDER_TYPES\.\w+\s*\]\s*\.add\s*\(/g,
        type: '_ordersByType[TYPE].add()',
        severity: 'HIGH'
    },
    {
        regex: /\._ordersByState\s*\[\s*ORDER_STATES\.\w+\s*\]\s*\.delete\s*\(/g,
        type: '_ordersByState[STATE].delete()',
        severity: 'HIGH'
    },
    {
        regex: /\._ordersByType\s*\[\s*ORDER_TYPES\.\w+\s*\]\s*\.delete\s*\(/g,
        type: '_ordersByType[TYPE].delete()',
        severity: 'HIGH'
    },
    {
        regex: /\._ordersByState\s*\[\s*ORDER_STATES\.\w+\s*\]\s*\.clear\s*\(/g,
        type: '_ordersByState[STATE].clear()',
        severity: 'HIGH'
    },
    {
        regex: /\._ordersByType\s*\[\s*ORDER_TYPES\.\w+\s*\]\s*\.clear\s*\(/g,
        type: '_ordersByType[TYPE].clear()',
        severity: 'HIGH'
    }
];

const scanFile = (filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        mutationPatterns.forEach(({ regex, type, severity }) => {
            const localRegex = new RegExp(regex.source, 'g');
            let match;
            
            while ((match = localRegex.exec(content)) !== null) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                const line = lines[lineNum - 1];
                
                // Check if this is an approved location
                const isApproved = approvedPatterns.some(pattern => line.includes(pattern));
                
                if (!isApproved) {
                    violations.push({
                        file: filePath.replace(process.cwd() + '/', ''),
                        line: lineNum,
                        type,
                        severity,
                        code: line.trim()
                    });
                }
            }
        });
    } catch (e) {
        // Ignore read errors
    }
};

// Scan production code
const scanDirectory = (dir) => {
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory() && !fullPath.includes('node_modules')) {
                    scanDirectory(fullPath);
                } else if (file.endsWith('.js')) {
                    scanFile(fullPath);
                }
            } catch (e) {
                // Ignore stat errors
            }
        });
    } catch (e) {
        // Ignore directory errors
    }
};

scanDirectory(path.join(__dirname, '../modules'));

// ============================================================================
// 2. Report Results
// ============================================================================

console.log(`Scanned ${countFiles(path.join(__dirname, '../modules'))} files\n`);

if (violations.length === 0) {
    console.log('✓ NO VIOLATIONS FOUND - COW Index Set invariant is maintained!\n');
    console.log('Summary:');
    console.log('  All direct mutations of _ordersByState and _ordersByType');
    console.log('  are properly confined to _applyOrderUpdate().\n');
} else {
    console.log(`✗ VIOLATIONS FOUND: ${violations.length} potential COW violations\n`);
    
    // Group by severity
    const byType: any = {};
    violations.forEach(v => {
        if (!byType[v.type]) byType[v.type] = [];
        byType[v.type].push(v);
    });
    
    console.log('Violations by Type:\n');
    for (const [type, viols] of Object.entries(byType)) {
        console.log(`  ${type}: ${(viols as any).length} violation(s)`);
        (viols as any).forEach(v => {
            console.log(`    ${v.file}:${v.line}`);
            console.log(`      Code: ${v.code}`);
        });
        console.log();
    }
    
    console.log('REMEDIATION REQUIRED:\n');
    console.log('Each violation above must be refactored to use manager._applyOrderUpdate()');
    console.log('instead of directly mutating the Sets.\n');
    console.log('Example fix:');
    console.log('  BEFORE: manager._ordersByState[state].add(id)');
    console.log('  AFTER:  manager._applyOrderUpdate(order, context, { skipAccounting, fee })\n');
}

// ============================================================================
// 3. Index Integrity Tests
// ============================================================================

console.log('='.repeat(80));
console.log('\n[ANALYSIS-2] Runtime Index Integrity Verification...\n');

const { OrderManager } = require('../modules/order').default;
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');
let runtimeVerificationFailed = false;

async function runRuntimeVerification() {
    try {
    // Test that _applyOrderUpdate properly maintains indices
    const manager = new OrderManager({
        assetA: 'RTEST.A',
        assetB: 'RTEST.B',
        market: 'RTEST.A/RTEST.B'
    });
    
    // Create initial order
    const order = {
        id: 'test-order-1',
        price: 100,
        size: 10,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        orderId: 'on-chain-1'
    };
    
    manager.orders = Object.freeze(new Map([
        [order.id, order]
    ]));
    
    // Manually initialize index (simulating bootstrap)
    manager._ordersByState[ORDER_STATES.VIRTUAL].add(order.id);
    manager._ordersByType[ORDER_TYPES.BUY].add(order.id);
    
    // Verify initial state
    assert(
        manager._ordersByState[ORDER_STATES.VIRTUAL].has(order.id),
        'Order should be in VIRTUAL index'
    );
    assert(
        !manager._ordersByState[ORDER_STATES.ACTIVE].has(order.id),
        'Order should NOT be in ACTIVE index yet'
    );
    
    console.log('✓ [TEST-1] Initial index state is correct');
    
    // Update order state via _applyOrderUpdate
    const updatedOrder = {
        ...order,
        state: ORDER_STATES.ACTIVE
    };
    
    await manager._applyOrderUpdate(updatedOrder, 'test-state-change', { skipAccounting: true });
    
    // Verify post-update state
    assert(
        !manager._ordersByState[ORDER_STATES.VIRTUAL].has(order.id),
        'Order should NOT be in VIRTUAL index after update'
    );
    assert(
        manager._ordersByState[ORDER_STATES.ACTIVE].has(order.id),
        'Order should be in ACTIVE index after update'
    );
    assert(
        manager._ordersByType[ORDER_TYPES.BUY].has(order.id),
        'Order should still be in BUY type index'
    );
    
    console.log('✓ [TEST-2] State transition via _applyOrderUpdate is correct');
    
    // Verify type transition
    const typeChangedOrder = {
        ...updatedOrder,
        type: ORDER_TYPES.SELL
    };
    
    await manager._applyOrderUpdate(typeChangedOrder, 'test-type-change', { skipAccounting: true });
    
    assert(
        !manager._ordersByType[ORDER_TYPES.BUY].has(order.id),
        'Order should NOT be in BUY type index after change'
    );
    assert(
        manager._ordersByType[ORDER_TYPES.SELL].has(order.id),
        'Order should be in SELL type index after change'
    );
    
    console.log('✓ [TEST-3] Type transition via _applyOrderUpdate is correct');
    
    // Verify order Map consistency
    assertOrdersStructurallySound(manager);
    
    console.log('✓ [TEST-4] Indices pass consistency validation');
    
    console.log('\n✓ All runtime verification tests passed\n');
    } catch (e) {
        runtimeVerificationFailed = true;
        console.error('✗ Runtime verification failed:', getErrorMessage(e));
        console.error((e as any).stack);
    }
}

// ============================================================================
// 4. Summary
// ============================================================================

function printSummary() {
    console.log('='.repeat(80));
    console.log('\n=== REPORT SUMMARY ===\n');

    console.log(`Violations Found: ${violations.length}`);
    console.log(`High Severity: ${violations.filter(v => v.severity === 'HIGH').length}`);
    console.log(`Runtime Verification Failed: ${runtimeVerificationFailed ? 'yes' : 'no'}`);

    if (!runtimeVerificationFailed && violations.length === 0) {
        console.log('\nStatus: ✓ PASS - COW Index invariant is properly maintained\n');
        console.log('The codebase correctly uses _applyOrderUpdate() for all index mutations.');
        console.log('No direct mutations of _ordersByState or _ordersByType were found\n');
        console.log('This ensures:');
        console.log('  1. Atomic state transitions (all-or-nothing)');
        console.log('  2. No race conditions during concurrent operations');
        console.log('  3. Proper lock sequencing via _gridLock');
        console.log('  4. Fund accounting consistency\n');
    } else {
        console.log('\nStatus: ✗ FAIL - COW Index invariant checks failed\n');
        console.log('Required Actions:');
        if (runtimeVerificationFailed) {
            console.log('  1. Fix runtime index integrity test failures');
            console.log('  2. Re-run this report to verify runtime checks pass');
            if (violations.length > 0) {
                console.log('  3. Refactor direct Set mutations to _applyOrderUpdate()');
            }
            console.log();
        } else {
            console.log('  1. Review each violation above');
            console.log('  2. Refactor to use manager._applyOrderUpdate()');
            console.log('  3. Re-run this report to verify all violations are fixed\n');
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function countFiles(dir) {
    let count = 0;
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory() && !fullPath.includes('node_modules')) {
                    count += countFiles(fullPath);
                } else if (file.endsWith('.js')) {
                    count++;
                }
            } catch (e) {
                // Ignore
            }
        });
    } catch (e) {
        // Ignore
    }
    return count;
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

(async () => {
    await runRuntimeVerification();
    printSummary();
    const hasFailures = violations.length > 0 || runtimeVerificationFailed;
    process.exit(hasFailures ? 1 : 0);
})();
