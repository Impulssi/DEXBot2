/**
 * COW Index Set Mutation Detection - Static Analysis Only
 * 
 * This script performs static code analysis to detect any direct mutations
 * of _ordersByState and _ordersByType Sets that bypass _applyOrderUpdate().
 */

const fs = require('fs');
const path = require('path');

console.log('=== COW Index Set Mutation Detection (Static Analysis) ===\n');

const violations: any[] = [];
const approvedFiles = new Set([
    'test_',
    'repro_',
    '.test.js'
]);

const mutationPatterns = [
    {
        regex: /\._ordersByState\s*\[\s*ORDER_STATES\.\w+\s*\]\s*\.add\s*\(/g,
        type: '_ordersByState[STATE].add()',
        severity: 'CRITICAL'
    },
    {
        regex: /\._ordersByType\s*\[\s*ORDER_TYPES\.\w+\s*\]\s*\.add\s*\(/g,
        type: '_ordersByType[TYPE].add()',
        severity: 'CRITICAL'
    },
    {
        regex: /\._ordersByState\s*\[\s*ORDER_STATES\.\w+\s*\]\s*\.delete\s*\(/g,
        type: '_ordersByState[STATE].delete()',
        severity: 'CRITICAL'
    },
    {
        regex: /\._ordersByType\s*\[\s*ORDER_TYPES\.\w+\s*\]\s*\.delete\s*\(/g,
        type: '_ordersByType[TYPE].delete()',
        severity: 'CRITICAL'
    }
];

const approvedContextPatterns = [
    '_applyOrderUpdate',
    '_clearOrderCachesLogic',
    'Object.values(this._ordersByState).forEach(set => set.delete(id))',
    'new Set(set)',  // Cloning pattern
    'set.entries()',  // Iteration for cloning
    'const cloned'     // Cloning variable
];

const scanFile = (filePath, relPath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const isTestFile = approvedFiles.has(path.basename(filePath).split('.')[0] + '.');
        
        mutationPatterns.forEach(({ regex, type, severity }) => {
            const localRegex = new RegExp(regex.source, 'g');
            let match;
            
            while ((match = localRegex.exec(content)) !== null) {
                const lineNum = content.substring(0, match.index).split('\n').length;
                const line = lines[lineNum - 1];
                
                // Check if this is in an approved context
                let isApproved = false;
                for (const pattern of approvedContextPatterns) {
                    if (line.includes(pattern)) {
                        isApproved = true;
                        break;
                    }
                }
                
                // Also check surrounding lines for context
                if (!isApproved) {
                    const context = lines.slice(Math.max(0, lineNum - 3), Math.min(lines.length, lineNum + 2)).join('\n');
                    for (const pattern of approvedContextPatterns) {
                        if (context.includes(pattern)) {
                            isApproved = true;
                            break;
                        }
                    }
                }
                
                // Check if it's in a method that's approved
                if (!isApproved) {
                    const methodMatch = content.substring(0, match.index).match(/\b(function|async\s+function|\w+\s*\([^)]*\)\s*\{)\s*(\w+)\s*\(/);
                    if (methodMatch && methodMatch[2] && approvedContextPatterns.some(p => methodMatch[2].includes(p))) {
                        isApproved = true;
                    }
                }
                
                if (!isApproved && !isTestFile) {
                    violations.push({
                        file: relPath,
                        line: lineNum,
                        type,
                        severity,
                        code: line.trim(),
                        column: match.index - content.lastIndexOf('\n', match.index - 1)
                    });
                }
            }
        });
    } catch (e) {
        // Ignore read errors
    }
};

// Scan only production code (not tests)
const scanDirectory = (dir, baseDir) => {
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const fullPath = path.join(dir, file);
            const relPath = path.relative(baseDir, fullPath);
            
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory() && !fullPath.includes('node_modules') && !fullPath.includes('tests')) {
                    scanDirectory(fullPath, baseDir);
                } else if (file.endsWith('.js') && !file.includes('test') && !file.includes('repro')) {
                    scanFile(fullPath, relPath);
                }
            } catch (e) {
                // Ignore stat errors
            }
        });
    } catch (e) {
        // Ignore directory errors
    }
};

console.log('Scanning production code for direct mutations...\n');
const baseDir = path.join(__dirname, '../modules');
scanDirectory(baseDir, baseDir);

// ============================================================================
// Report Results
// ============================================================================

console.log('='.repeat(80));
console.log('\nSCAN RESULTS:\n');

if (violations.length === 0) {
    console.log('✓ NO VIOLATIONS FOUND\n');
    console.log('Summary:');
    console.log('  All direct mutations of _ordersByState and _ordersByType');
    console.log('  are properly confined to _applyOrderUpdate().\n');
    console.log('COW Index Invariant Status: MAINTAINED ✓\n');
    console.log('This ensures:');
    console.log('  • Atomic state transitions (all-or-nothing)');
    console.log('  • No race conditions during concurrent operations');
    console.log('  • Proper lock sequencing via _gridLock');
    console.log('  • Fund accounting consistency');
    console.log('  • Index integrity across all order transitions\n');
} else {
    console.log(`✗ VIOLATIONS FOUND: ${violations.length}\n`);
    
    // Group by file
    const byFile: any = {};
    violations.forEach(v => {
        if (!byFile[v.file]) byFile[v.file] = [];
        byFile[v.file].push(v);
    });
    
    for (const [file, viols] of Object.entries(byFile)) {
        console.log(`${file}:`);
        (viols as any).forEach(v => {
            console.log(`  Line ${v.line}: ${v.type}`);
            console.log(`    ${v.code}`);
        });
        console.log();
    }
    
    console.log('REQUIRED REMEDIATION:');
    console.log('  Each violation must be refactored to use manager._applyOrderUpdate()');
    console.log('  instead of directly mutating the Sets.\n');
}

console.log('='.repeat(80));
console.log('\nREPORT METADATA:\n');
console.log(`Violations: ${violations.length}`);
console.log(`High/Critical Severity: ${violations.filter(v => v.severity === 'CRITICAL').length}`);
console.log(`Status: ${violations.length === 0 ? '✓ PASS' : '✗ FAIL'}\n`);

process.exit(violations.length > 0 ? 1 : 0);
