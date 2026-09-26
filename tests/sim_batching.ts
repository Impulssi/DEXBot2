// Batch sizing mirror for documentation: the production cap is the grid
// gap-slot count + 1 (DEXBot._getGapSlotBatchSize); this sim uses gapSlots=4.
const GAP_SLOTS = 4;

function simulateBatching(totalFills) {
    const maxBatch = Math.max(1, GAP_SLOTS) + 1;

    const useUnifiedPlan = totalFills <= maxBatch;
    
    const batches = [];
    let i = 0;
    while (i < totalFills) {
        const remaining = totalFills - i;
        let currentBatchSize;

        if (useUnifiedPlan) {
            currentBatchSize = remaining;
        } else {
            currentBatchSize = Math.min(maxBatch, remaining);
        }

        const batchEnd = Math.min(i + currentBatchSize, totalFills);
        batches.push(batchEnd - i);
        i = batchEnd;
    }
    return { maxBatch, useUnifiedPlan, batches };
}

const testCases = [1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17, 20];
console.log("Queue Depth | Max Batch | Unified? | Batch Sequence");
console.log("----------------------------------------------------");
for (const depth of testCases) {
    const result = simulateBatching(depth);
    console.log(`${depth.toString().padEnd(12)}| ${result.maxBatch.toString().padEnd(10)}| ${result.useUnifiedPlan.toString().padEnd(9)}| [${result.batches.join(", ")}]`);
}
