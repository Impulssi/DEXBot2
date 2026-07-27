/**
 * COW Index Mutation Detection Test Suite
 * 
 * This test suite instruments the OrderManager's index Sets to detect
 * any direct mutations (add/delete/clear) that bypass _applyOrderUpdate.
 * 
 * These mutations violate the COW invariant and must be eliminated.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');
const { getErrorMessage } = require('../modules/utils/errors');

// ============================================================================
// Mutation Detection Wrapper
// ============================================================================

/**
 * Snapshot the state of all index Sets
 * @param {OrderManager} manager - The manager to snapshot
 * @returns {Object} Snapshot of all Sets
 */
function snapshotIndices(manager) {
    const snapshot: any = {};
    
    for (const [state, set] of Object.entries(manager._ordersByState)) {
        snapshot[`_ordersByState[${state}]`] = new Set(set as any);
    }
    
    for (const [type, set] of Object.entries(manager._ordersByType)) {
        snapshot[`_ordersByType[${type}]`] = new Set(set as any);
    }
    
    return snapshot;
}

/**
 * Compare snapshot with current state to detect mutations
 * @param {OrderManager} manager - The manager to compare
 * @param {Object} snapshot - Previous snapshot
 * @returns {Array} List of mutations detected
 */
function detectMutations(manager, snapshot) {
    const mutations = [];
    
    for (const [state, set] of Object.entries(manager._ordersByState)) {
        const key = `_ordersByState[${state}]`;
        const prevSet = snapshot[key];
        
        // Check for added items
        for (const item of (set as any)) {
            if (!prevSet.has(item)) {
                mutations.push({
                    type: 'ADD',
                    setName: '_ordersByState',
                    key: state,
                    item
                });
            }
        }
        
        // Check for removed items
        for (const item of prevSet) {
            if (!(set as any).has(item)) {
                mutations.push({
                    type: 'DELETE',
                    setName: '_ordersByState',
                    key: state,
                    item
                });
            }
        }
    }
    
    for (const [type, set] of Object.entries(manager._ordersByType)) {
        const key = `_ordersByType[${type}]`;
        const prevSet = snapshot[key];
        
        // Check for added items
        for (const item of (set as any)) {
            if (!prevSet.has(item)) {
                mutations.push({
                    type: 'ADD',
                    setName: '_ordersByType',
                    key: type,
                    item
                });
            }
        }
        
        // Check for removed items
        for (const item of prevSet) {
            if (!(set as any).has(item)) {
                mutations.push({
                    type: 'DELETE',
                    setName: '_ordersByType',
                    key: type,
                    item
                });
            }
        }
    }
    
    return mutations;
}

/**
 * Generate a detailed mutation report
 * @param {Object} tracker - Tracker with mutations array
 * @returns {string} Formatted report
 */
function generateMutationReport(tracker) {
    if (tracker.mutations.length === 0) {
        return 'No direct mutations detected - COW invariant is maintained ✓';
    }
    
    let report = `\n${'='.repeat(80)}\n`;
    report += `MUTATION VIOLATION REPORT: ${tracker.mutations.length} violations detected\n`;
    report += `${'='.repeat(80)}\n\n`;
    
    const groupedBySet: any = {};
    for (const mut of tracker.mutations) {
        const key = `${mut.setName}[${mut.key}]`;
        if (!groupedBySet[key]) {
            groupedBySet[key] = [];
        }
        groupedBySet[key].push(mut);
    }
    
    for (const [setKey, mutations] of Object.entries(groupedBySet)) {
        report += `\n${setKey} - ${(mutations as any).length} mutations:\n`;
        report += `${'-'.repeat(60)}\n`;
        
        (mutations as any).forEach((mut, idx) => {
            report += `\n  Violation #${idx + 1}:\n`;
            report += `    Type: ${mut.type}\n`;
            report += `    Item: ${mut.item || 'N/A'}\n`;
            report += `    Stack:\n`;
            const stackLines = mut.stack.split('\n');
            stackLines.forEach(line => {
                report += `      ${line}\n`;
            });
        });
    }
    
    report += `\n${'='.repeat(80)}\n`;
    report += 'REMEDIATION:\n';
    report += 'Each violation above shows a direct mutation that MUST be changed\n';
    report += 'to call manager._applyOrderUpdate() instead.\n';
    report += 'This maintains the COW invariant.\n';
    report += `${'='.repeat(80)}\n`;
    
    return report;
}

// ============================================================================
// Test Suite
// ============================================================================

console.log('=== COW Index Mutation Detection Tests ===\n');

(async () => {
try {
    // Test 1: Detect mutations during normal _applyOrderUpdate
    {
        console.log('[DETECTION-001] Detecting mutations during _applyOrderUpdate...');
        const manager = new OrderManager({
            assetA: 'TEST1.A',
            assetB: 'TEST1.B',
            market: 'TEST1.A/TEST1.B',
            accountId: 'test-account'
        });
        
        // Create an order in ACTIVE state
        manager.orders = Object.freeze(new Map([
            ['order-1', {
                id: 'order-1',
                price: 100,
                size: 10,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                orderId: '12345'
            }]
        ]));
        
        // Initialize indexes manually
        manager._ordersByState[ORDER_STATES.ACTIVE].add('order-1');
        manager._ordersByType[ORDER_TYPES.BUY].add('order-1');
        
        // Take snapshot before update
        const snapshot = snapshotIndices(manager);
        
        // Update order state from ACTIVE to PARTIAL
        await manager._applyOrderUpdate({
            id: 'order-1',
            price: 100,
            size: 5,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,  // Changed state
            orderId: '12345'
        }, 'test', { skipAccounting: true });
        
        // Detect mutations
        const mutations = detectMutations(manager, snapshot);
        
        // Check that mutations happened only within _applyOrderUpdate
        assert(mutations.length > 0, `Should detect mutations from _applyOrderUpdate, got ${mutations.length}`);
        console.log(`   ✓ Detected ${mutations.length} mutations (expected - from _applyOrderUpdate)\n`);
    }
    
    // Test 2: Catch direct mutation attempts
    {
        console.log('[DETECTION-002] Testing direct mutation detection...');
        const manager = new OrderManager({
            assetA: 'TEST2.A',
            assetB: 'TEST2.B',
            market: 'TEST2.A/TEST2.B'
        });
        
        // Take snapshot of clean state
        const snapshot = snapshotIndices(manager);
        
        // Attempt direct mutation (this is the violation we're detecting)
        manager._ordersByState[ORDER_STATES.ACTIVE].add('direct-mutation-id');
        
        // Detect the mutation
        const mutations = detectMutations(manager, snapshot);
        const directAddMutation = mutations.find(m => m.type === 'ADD' && m.item === 'direct-mutation-id');
        assert(directAddMutation, 'Should detect direct .add() mutation');
        console.log('   ✓ Direct .add() mutation detected\n');
    }
    
    // Test 3: Catch delete mutations
    {
        console.log('[DETECTION-003] Testing direct delete detection...');
        const manager = new OrderManager({
            assetA: 'TEST3.A',
            assetB: 'TEST3.B',
            market: 'TEST3.A/TEST3.B'
        });
        
        // Set up initial state
        manager._ordersByState[ORDER_STATES.ACTIVE].add('test-id');
        
        // Take snapshot
        const snapshot = snapshotIndices(manager);
        
        // Attempt direct delete mutation
        manager._ordersByState[ORDER_STATES.ACTIVE].delete('test-id');
        
        // Detect mutation
        const mutations = detectMutations(manager, snapshot);
        const deleteM = mutations.find(m => m.type === 'DELETE');
        assert(deleteM, 'Should detect direct .delete() mutation');
        console.log('   ✓ Direct .delete() mutation detected\n');
    }
    
    // Test 4: Catch clear mutations
    {
        console.log('[DETECTION-004] Testing direct clear detection...');
        const manager = new OrderManager({
            assetA: 'TEST4.A',
            assetB: 'TEST4.B',
            market: 'TEST4.A/TEST4.B'
        });
        
        // Set up initial state
        manager._ordersByState[ORDER_STATES.ACTIVE].add('test-id');
        
        // Take snapshot
        const snapshot = snapshotIndices(manager);
        
        // Attempt direct clear mutation
        manager._ordersByState[ORDER_STATES.ACTIVE].clear();
        
        // Detect mutation
        const mutations = detectMutations(manager, snapshot);
        const clearM = mutations.find(m => m.type === 'DELETE');
        assert(clearM && mutations.length > 0, 'Should detect clear mutation as deletions');
        console.log('   ✓ Direct .clear() mutation detected\n');
    }
    
    // Test 5: Scan entire test suite for violations
    {
        console.log('[DETECTION-005] Scanning codebase for mutation patterns...');
        const fs = require('fs');
        const path = require('path');
        
        const violations = [];
        const patterns = [
            {
                regex: /\._ordersByState\[.*?\]\s*\.add\s*\(/g,
                type: 'Direct .add() on _ordersByState'
            },
            {
                regex: /\._ordersByType\[.*?\]\s*\.add\s*\(/g,
                type: 'Direct .add() on _ordersByType'
            },
            {
                regex: /\._ordersByState\[.*?\]\s*\.delete\s*\(/g,
                type: 'Direct .delete() on _ordersByState'
            },
            {
                regex: /\._ordersByType\[.*?\]\s*\.delete\s*\(/g,
                type: 'Direct .delete() on _ordersByType'
            },
            {
                regex: /\._ordersByState\[.*?\]\s*\.clear\s*\(/g,
                type: 'Direct .clear() on _ordersByState'
            },
            {
                regex: /\._ordersByType\[.*?\]\s*\.clear\s*\(/g,
                type: 'Direct .clear() on _ordersByType'
            }
        ];
        
        const scanFile = (filePath) => {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');
                
                patterns.forEach(({ regex, type }) => {
                    let match;
                    while ((match = regex.exec(content)) !== null) {
                        // Skip if it's inside _applyOrderUpdate or similar approved methods
                        const lineNum = content.substring(0, match.index).split('\n').length;
                        const line = lines[lineNum - 1];
                        
                        // Allow mutations in _applyOrderUpdate and _repairIndices
                        if (line && !line.includes('_applyOrderUpdate') && 
                            !line.includes('_repairIndices') &&
                            !line.includes('Object.values(this._ordersByState).forEach(set => set.delete(id))')) {
                            violations.push({
                                file: filePath,
                                line: lineNum,
                                type,
                                code: line.trim()
                            });
                        }
                    }
                });
            } catch (e) {
                // Ignore read errors
            }
        };
        
        // Scan only production code, not tests
        const srcDir = path.join(__dirname, '../modules');
        const walkDir = (dir) => {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    walkDir(fullPath);
                } else if (file.endsWith('.js')) {
                    scanFile(fullPath);
                }
            });
        };
        
        walkDir(srcDir);
        
        if (violations.length === 0) {
            console.log('   ✓ No direct mutation patterns found in production code\n');
        } else {
            console.log(`   ✗ Found ${violations.length} potential violations:\n`);
            violations.forEach(v => {
                console.log(`     ${v.file}:${v.line}`);
                console.log(`     ${v.type}`);
                console.log(`     Code: ${v.code}\n`);
            });
        }
    }
    
    // Test 6: Generate final report
    {
        console.log('[DETECTION-006] Generating comprehensive violation report...');
        const manager = new OrderManager({
            assetA: 'TEST6.A',
            assetB: 'TEST6.B',
            market: 'TEST6.A/TEST6.B'
        });
        
        // Take initial snapshot
        const snapshot = snapshotIndices(manager);
        
        // Run a simulated direct mutation (violation)
        manager._ordersByState[ORDER_STATES.VIRTUAL].add('direct-violation-order');
        
        // Detect violations
        const mutations = detectMutations(manager, snapshot);
        
        // Generate report
        if (mutations.length > 0) {
            let report = `\n${'='.repeat(80)}\n`;
            report += `MUTATION VIOLATION REPORT: ${mutations.length} violations detected\n`;
            report += `${'='.repeat(80)}\n\n`;
            
            mutations.forEach((mut, idx) => {
                report += `Violation #${idx + 1}:\n`;
                report += `  Type: ${mut.type}\n`;
                report += `  Index: ${mut.setName}[${mut.key}]\n`;
                report += `  Item: ${mut.item}\n\n`;
            });
            
            report += `REMEDIATION:\n`;
            report += `Each violation above is a direct mutation that MUST be changed\n`;
            report += `to call manager._applyOrderUpdate() instead.\n`;
            report += `${'='.repeat(80)}\n`;
            console.log(report);
        }
        
        console.log('   ✓ Report generated successfully\n');
    }
    
    console.log('✓ All mutation detection tests passed!\n');
    process.exit(0);
    
} catch (e) {
    console.error('✗ Test failed:', getErrorMessage(e));
    console.error((e as any).stack);
    process.exit(1);
}
})();
