# DEXBot2 Fund Movement & Accounting Technical Reference

## 1. Core Accounting Model

The accounting system is designed around a **Single Source of Truth** principle with **Optimistic Execution**. It prevents double-spending while maximizing capital efficiency by treating pending proceeds as immediately available ("Optimistic ChainFree").

### 1.1 Fund Components

| Component | Code Reference | Definition & Ownership |
|-----------|----------------|------------------------|
| **ChainFree** | `accountTotals.buyFree` | **Liquid Capital**. The unallocated balance on the blockchain. <br> *Balanced:* Deducted pre-emptively on fills to offset state release. |
| **Virtual** | `funds.virtual` | **Planned Capital**. Sum of sizes for orders in `VIRTUAL` state. <br> *Purpose:* Prevents `ChainFree` from being re-spent on overlapping grid layers. |
| **Committed (Chain)** | `funds.committed.chain` | **Locked Capital**. Sum of sizes for `ACTIVE` + `PARTIAL` orders (including those without `orderId` yet). <br> *Source:* Real-time grid state + on-chain orders. |
| **Committed (Grid)** | `funds.committed.grid` | **Strategy Capital**. Alias for `committed.chain` in the current engine. |
| **FeesOwed** | `funds.btsFeesOwed` | **Liability**. Accumulated blockchain fees (BTS) that must be settled. |
| **FeesReservation** | `btsFeesReservation` | **Safety Buffer**. Reserved BTS to ensure future grid operations (creation/cancellation) don't fail. |

### 1.2 The Available Funds Formula

This formula determines the bot's spending power. It is calculated atomically in `math.ts::calculateAvailableFundsValue`.

$$Available = \max(0, \text{ChainFree} - \text{Virtual} - \text{FeesOwed} - \text{FeesReservation})$$

**Critical Invariants:**
1.  **Virtual represents Plan.** Orders remain in `Virtual` only while they are truly uncommitted. As soon as they move to `ACTIVE`, they move to `Committed` (Chain), even if the blockchain transaction is still in flight. This maintains the `Total = Free + Committed` invariant.
2.  **Available Funds = True Spending Power.** This formula is the single source of truth for how much capital can be deployed immediately.

---

## 1.3 Mixed Order Fund Validation

**Problem Fixed**: When `_buildCreateOps()` received both BUY and SELL orders in a batch, it used a single fund check on the first order's type. This caused false "insufficient funds" warnings when placing mixed BUY/SELL batches, even though the bot had sufficient capital on both sides — the BUY check was applied to SELL orders (or vice versa).

**Solution**: Separate validation per order type.

### Fund Availability Checks by Order Type

**BUY Orders** validate against `buyFree` (assetB capital):
```
buyFree represents unallocated assetB available for limit orders
```

**SELL Orders** validate against `sellFree` (assetA inventory):
```
sellFree represents unallocated assetA available for limit orders
```

### Implementation Location

File: `modules/dexbot_class.ts` — `_buildCreateOps()` (removed, logic consolidated into `_rebalanceGridOrders()`)

```javascript
// Separate BUY and SELL orders
const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);
const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);

// BUY orders: check assetB capital (buyFree)
if (buyOrders.length > 0) {
    const buyTotal = buyOrders.reduce((sum, o) => sum + o.size, 0);
    if (buyTotal > this.accountTotals.buyFree) {
        // Log fund warning specific to BUY side
    }
}

// SELL orders: check assetA inventory (sellFree)
if (sellOrders.length > 0) {
    const sellTotal = sellOrders.reduce((sum, o) => sum + o.size, 0);
    if (sellTotal > this.accountTotals.sellFree) {
        // Log fund warning specific to SELL side
    }
}
```

### Key Points

1. **Each order validated independently** against its own type's available funds
2. **No double-counting** when both BUY and SELL orders are placed simultaneously
3. **Accurate warnings** showing which side lacks funds (BUY vs SELL)
4. **Prevents false positives** where mixed placements incorrectly appear to exceed available capital

### Helper Reference

For checking order types and states, use centralized helpers from `modules/order/utils/`:
- `isOrderOnChain()` - Check if ACTIVE or PARTIAL
- `isOrderPlaced()` - Check if safely placed (on-chain with ID)
- `isOrderVirtual()` - Check if VIRTUAL state

See [developer_guide.md#order-state-helper-functions](developer_guide.md#order-state-helper-functions) for complete helper function reference.

---

## 1.4 Fill Batch Processing & Timeline

### Problem Solved

Previously, fills were processed one-at-a-time (~3s per broadcast). A burst of 29 fills in the Feb 7 market crash took ~90 seconds, during which:
- Market prices moved significantly
- Orders became stale (filled on-chain but not yet synced)
- Orphan fills were created (fill events for orders no longer on-chain)
- Fund tracking diverged from blockchain reality

**Impact**: The extended 90s window meant the bot couldn't react to market moves, creating a cascading failure.

### Solution: Fixed-Cap Batch Fill Processing

**Mechanism** (`modules/order/manager.ts::processFilledOrders`): Groups fills into capped batches before executing the full rebalance pipeline.

**Batch Sizing Algorithm**:
```javascript
// Single cap-based batch size
const batchSize = MAX_FILL_BATCH_SIZE;
// queueDepth<=4 -> single unified batch of queueDepth
// queueDepth>4  -> chunk into repeated batches of 4 (last chunk may be smaller)
```

**Configuration** (`modules/constants.ts`):
```javascript
FILL_PROCESSING: {
  MAX_FILL_BATCH_SIZE: 4            // Hard cap on batch size
}
```

### Fill Batch Processing Timeline

**Per-Batch Execution**:

1. **Peek & Pop**: Check `_incomingFillQueue`, pop up to N fills (batch size)
2. **Single Accounting Pass**: Call `processFillAccounting()` once for all N fills
   - All proceeds credited directly to `chainFree` (via `adjustTotalBalance`)
   - All proceeds immediately available to next rebalance cycle (not split across cycles)
3. **Single Target Calculation**: Call `calculateTargetGrid()` once
   - Sizes replacement orders using combined proceeds
   - Applies rotations and boundary shifts
4. **Batch Broadcast**: Call `updateOrdersOnChainBatch()` once
   - All new orders + cancellations in single operation
5. **Persist**: Call `persistGrid()` to save grid state
6. **Loop**: Continue with next batch (or idle if queue empty)

**Result**: 29 fills now processed in ~8 broadcasts (~24s) instead of 29 broadcasts (~90s).

### Grid Regeneration Trigger (Available Funds Ratio)

The grid regenerates when accumulated proceeds create a significant funding imbalance. This is detected using the **Available Funds Ratio**:

```
ratio = (availableFunds / allocatedCapital) * 100

IF ratio >= GRID_REGENERATION_PERCENTAGE (default: 3%):
    → Trigger grid regeneration
```

**How It Works**:
1. Fill occurs → proceeds added to `chainFree`
2. `calculateAvailableFundsValue()` computes true spending power (chainFree minus reservations)
3. Grid divergence check compares this ratio against allocated capital in active orders
4. If ratio exceeds 3%, the grid has accumulated enough proceeds to warrant redeployment
5. Grid regeneration recalculates all order sizes and applies new placements

### Recovery Retry System

**Problem**: One-shot `_recoveryAttempted` boolean flag meant permanent lockup if recovery failed once.

**New Behavior**: Count+time-based retry system with periodic reset.

**State Machine**:
```
INITIAL (count=0, time=0)
    ↓
RECOVERY_FAILED (count++, time=now) ← Recovery attempted but failed
    ↓ (wait 60s)
READY_RETRY (count < 5 and time_elapsed ≥ 60s) ← Time passed, can retry
    ↓
RECOVERY_ATTEMPTED (increment count) ← Attempt retry
    ↓ (on fail) ← Success not yet
    ↓ ← Loops back to RECOVERY_FAILED
    ↓ (on success)
RESET via resetRecoveryState() ← Recovery succeeded, reset for next episode
```

**Configuration** (`modules/constants.ts`):
```javascript
PIPELINE_TIMING: {
  RECOVERY_RETRY_INTERVAL_MS: 60000,  // Min 60s between retry attempts
  MAX_RECOVERY_ATTEMPTS: 5            // Max 5 retries per episode (0 = unlimited)
}
```

**Reset Points** (Called by `resetRecoveryState()` in `modules/order/accounting.ts`):
1. **Fill-triggered**: Every fill in `processFilledOrders()` resets recovery state
2. **Periodic**: Blockchain fetch loop resets state every 10 minutes (even if no fills)
3. **Bootstrap completion**: After grid initialization

**Impact**: 
- ✅ If recovery fails, bot retries every 60s instead of requiring manual restart
- ✅ Self-heals within minutes after market settles
- ✅ No permanent lockup from single failure

### Stale-Cleaned Order ID Tracking

**Problem**: During batch execution failure, cleanup freed slots. Then delayed orphan fill events credited proceeds AGAIN = double-count.

**Solution**: Track stale-cleaned order IDs using timestamp-based TTL.

**Data Structure** (`modules/dexbot_class.ts`):
```javascript
_staleCleanedOrderIds = new Map();  // orderId → cleanupTimestamp
```

**Lifecycle**:
1. Batch fails: "Limit order X does not exist" error
2. Cleanup: Release slot, record `orderId + timestamp` in `_staleCleanedOrderIds`
3. Delayed Orphan: Fill event arrives for cleaned order
4. Guard Check: `_staleCleanedOrderIds.has(orderId)` → true
5. Skip Credit: Orphan handler skips crediting proceeds

**TTL Pruning**: Old entries pruned every 5 minutes to prevent unbounded map growth.

**Impact**:
- ✅ Eliminates double-counting root cause
- ✅ Handles delayed orphan events
- ✅ Prevents 47,842 BTS drift cascades

---

## 1.5 Remainder Accuracy During Capped Resize

### Problem Fixed

When grid resize was capped by available funds, the accounting system needed to track what portion of the ideal grid went unallocated. This required careful per-slot tracking to distinguish between:
- **Fully allocated slots**: received their ideal size (no remainder)
- **Fund-capped slots**: received less than ideal because available funds ran out mid-allocation

Without per-slot tracking, the remainder was computed from totals, which overstated it when some slots were fully allocated and others were capped.

### Solution: Per-Slot Tracking

**Old Behavior** (Incorrect):
```javascript
// Compute unallocated remainder from ideal sizes
const remainder = totalIdealSizes - totalAllocatedSizes;
// Problem: If actual allocation capped at 80% due to insufficient funds,
// this uses 100% ideal in calculation → remainder overstated
```

**New Behavior** (Correct):
```javascript
// Track per-slot applied sizes
const appliedSizes = [];
for (const slot of slots) {
    const appliedSize = min(idealSize[slot], availableFundsRemaining);
    appliedSizes.push(appliedSize);
    availableFundsRemaining -= appliedSize;
}

// Compute unallocated remainder from actual allocated values
const remainder = totalIdealSizes - sum(appliedSizes);
// Result: Reflects true remaining capacity for next cycle
```

**Impact**:
- ✅ Remainder accurately reflects what was NOT allocated due to fund caps
- ✅ Next rebalance cycle gets correct available fund picture
- ✅ No skewed sizing decisions

---



## 2. Grid Topology & Sizing

The grid is a unified array ("Master Rail") of price levels, not separate Buy/Sell arrays.

### 2.1 Geometric Weighting Formula

Order sizes are calculated using a geometric progression to distribute risk.

**Inputs:**
-   $N$: Number of orders
-   $Total$: Total budget for side
-   $w$: Weight Distribution parameter (`-1` to `2`)
-   $inc$: Increment factor (`incrementPercent / 100`)

**Base Factor:**
$$base = 1 - inc$$

**Raw Weight ($W_i$):**
For each slot $i$ from $0$ to $N-1$:
$$W_i = base^{(i \times w)}$$

**Orientation:**
-   **SELL Side:** Normal indexing ($i=0$ is market-closest).
-   **BUY Side:** Reversed indexing ($i=N-1$ is market-closest) to ensure heaviest weights are always near the spread.

**Final Size ($S_i$):**
$$S_i = \left( \frac{W_i}{\sum W} \right) \times Total$$

### 2.2 Spread Gap & Boundary

The grid is divided into zones by a dynamic **Boundary Index**.

-   **Gap Size ($G$):** Calculated from `targetSpreadPercent` and `incrementPercent`.
    $$G = \lceil \frac{\ln(1 + \text{targetSpread}/100)}{\ln(1 + \text{increment}/100)} \rceil - 1$$
    *(Min capped at `MIN_SPREAD_ORDERS`, usually 2. The $-1$ accounts for the naturally occurring center gap during grid centering)*

-   **Zones:**
    -   **BUY:** Indices $[0, \text{boundaryIdx}]$
    -   **SPREAD:** Indices $[\text{boundaryIdx}+1, \text{boundaryIdx}+G]$ (Total of $G+1$ actual gaps)
    -   **SELL:** Indices $[\text{boundaryIdx}+G+1, N]$

---

## 3. The Strategy Engine (Boundary-Crawl Algorithm)

The rebalancing logic (`strategy.ts::calculateTargetGrid`) computes the target "Crawl" state.

### 3.1 Boundary Shift (The Crawl)
When a fill occurs, the boundary shifts to "follow" the price.
-   **BUY Fill:** Market moved down $\to$ `boundaryIdx--` (Shift Left).
-   **SELL Fill:** Market moved up $\to$ `boundaryIdx++` (Shift Right).

### 3.2 Global Side Capping

Budgets are dynamic. The bot calculates `TotalSideBudget` based on `ChainFree` + `Committed`.

**Safety Check:**
If the calculated ideal grid requires more capital than is available, the *increase* is capped.
$$Increase_{capped} = \min(Ideal - Current, Available)$$

#### Batch Sizing Impact

During fill batch rebalancing, the unallocated remainder (amount NOT allocated due to fund caps) affects available funds for the next cycle:

**Remainder Calculation**:
- **Old**: Computed from ideal sizes even when resize was capped
- **New**: Tracked per-slot, derived from actual allocated values

**Effect on Side Capping Formula**:
```javascript
// In next rebalance cycle:
availableFunds = chainFree - virtual - feesOwed - feesReservation
sideIncrease = min(idealSide - currentSide, availableFunds)

// When batch capping applied in previous cycle:
// availableFunds now correctly reflects the unfulfilled allocation gap
```

**Example**:
```
Cycle N (Batch Processing):
- Ideal grid total: 1000 BTS
- Available funds: 600 BTS
- Allocate: 600 BTS (per-slot tracking)
- Unallocated remainder: 400 BTS (1000 - 600)

Cycle N+1:
- Unallocated remainder (400 BTS) available for next allocation
- Prevents "stuck fund" situations where capital appeared allocated but wasn't
```

**Impact**:
- ✅ Accurate available fund calculations for next rebalance
- ✅ No overstated fund capping in subsequent cycles
- ✅ Smooth rebalancing when market moves expand/contract positions

### 3.3 The Rotation Cycle
Rotations move capital from "Surplus" (useless) to "Shortage" (needed).

1.  **Identify Shortages:** Empty slots *inside* the active window (near boundary).
2.  **Identify Surpluses:** Active orders *outside* the window (far edges).
3.  **Sort:**
    -   Shortages: Closest to market first.
    -   Surpluses: Furthest from market first.
4.  **Execute:**
    For each pair (Surplus $S$, Shortage $T$):
    -   **Atomic Transition:**
        -   $S$ state: `ACTIVE` $\to$ `VIRTUAL` (size 0, releases funds).
        -   $T$ state: `VIRTUAL` (size $S_{size}$, reserves funds).
    -   **Fund Calculation:**
        -   The released funds from $S$ are immediately added to `ChainFree`.
        -   The reserved funds for $T$ are immediately subtracted (added to `Virtual`).

### 3.4 Edge-First Surplus Sorting

**Change**: Prioritize furthest-from-market surpluses (lowest Buy / highest Sell) for rotations.

**Reason**: Improves execution robustness by using stable edge orders for rotations and leaving volatile inner surpluses to potentially catch "surplus fills" during grid shifts.

**Impact**:
- ✅ More stable rotation candidates (outer orders less likely to be filled mid-operation)
- ✅ Inner surpluses remain available for spontaneous fill opportunities
- ✅ Reduces unnecessary churn on volatile price action

### 3.5 Victim Cancel Safety Logic

**Change**: Explicitly detect and cancel "victim" dust orders when a rotation targets an occupied slot.

**Reason**: Maintains 1-to-1 mapping between grid slots and blockchain orders in the Edge-First system, preventing "ghost" capital on-chain.

**Implementation**:
```javascript
// If rotation target slot has an order (victim), cancel it first
if (targetSlot.orderId) {
    scheduleCancel(targetSlot);
    targetSlot.state = VIRTUAL;  // Prepare slot for new order
}

// Then place new order at target
targetSlot.state = ACTIVE;
targetSlot.orderId = newOrderId;
```

**Impact**:
- ✅ Prevents "ghost" capital lingering on-chain
- ✅ Ensures grid slot ↔ blockchain order 1-to-1 mapping
- ✅ No orphaned capital in rotation operations

---

## 3.6 Orphan-Fill Deduplication & Double-Credit Prevention

**Location**: `modules/dexbot_class.ts` (constructor, `_handleBatchHardAbort()`, batch failure handler)

### Problem Solved

During Feb 7 market crash, stale-order batch failures cascaded into double-crediting:

**Scenario**:
1. Batch operation scheduled with 12 orders
2. Order X is on-chain, included in batch
3. Between sync and broadcast, order X fills on market (stale order)
4. Batch execution fails: "Limit order X does not exist"
5. Error handler: Clean up grid slot X, release funds to `chainFree`
6. Meanwhile, fill event arrives: "Order X was filled at price Y for amount Z"
7. Orphan-fill handler: Credits proceeds to `chainFree` AGAIN
8. **Result**: Double-credit of proceeds, inflated `chainTotal`, fund drift

**In Crash Numbers**: 7 orphan fills × ~700 BTS = ~4,600 BTS inflated → cascaded to 47,842 BTS total drift.

### Solution: Stale-Cleaned Order ID Tracking with TTL

**Mechanism**: Track which orders were cleaned up during batch failure recovery using timestamp retention.

**Data Structure** (`modules/dexbot_class.ts`):
```javascript
// Map of orderId → cleanupTimestamp
_staleCleanedOrderIds = new Map();
```

**Cleanup Process** (When batch fails):
```javascript
// In _handleBatchHardAbort() or batch error handler:
1. Parse error message for stale order IDs (e.g., "Limit order 12345 does not exist")
2. For each stale ID:
   - Find & clean grid slot (convert to SPREAD placeholder)
   - Record: _staleCleanedOrderIds.set(orderId, Date.now())
   - Log: "Cleaned stale order X from slot"
3. Periodically prune entries > 5 minutes old
```

**Orphan-Fill Handler Check**:
```javascript
// In orphan-fill event processing:
if (_staleCleanedOrderIds.has(orderId)) {
    logger.info(`[ORPHAN-FILL] Skipping double-credit for stale-cleaned order ${orderId}`);
    return;  // Don't credit proceeds
}

// Only credit if NOT in stale-cleaned map
logger.info(`[ORPHAN-FILL] Processing orphan ${orderId}, crediting ${proceeds}`);
adjustTotalBalance(orderType, proceeds, `orphan-fill-${orderId}`);
```

### Why This Works

1. **Delayed Orphans**: Fill events can arrive minutes after batch failure (network latency)
2. **TTL Pruning**: Map doesn't grow unbounded; entries removed after 5 minutes
3. **ID-Based**: Works with any error format (different BitShares versions have different error messages)
4. **Explicit Logging**: "Skipping double-credit" messages create audit trail

### Fund State Verification

The available funds are verified at allocation time:
- Proceeds are only added to `chainFree` when confirmed on blockchain
- Stale-cleaned orders don't consume allocation funds
- Next cycle sees accurate available funds for sizing decisions

### Impact

- ✅ **Eliminates double-counting root cause** that fed 47,842 BTS drift
- ✅ **Handles network-latent orphan events** (not just immediate fills)
- ✅ **No fund corruption** from delayed fill events after batch failure
- ✅ **Production stability** after market crashes and stale order cascades

---

## 4. Partial Order Handling (Simplified Consolidation)

When a grid is regenerated or resized, existing partial orders (partially filled orders) may remain on-chain. Rather than employing complex merge/split mechanics, the system uses a **direct consolidation approach** focused on fund efficiency and spreading simplicity.

### 4.1 Dust Detection

A partial order is classified as **Dust** if:
$$Size_{current} < Size_{ideal} \times 0.05$$

Dust orders are too small to be efficient on-chain and are marked for consolidation into the grid rebuild cycle.

### 4.2 Consolidation Strategy

When the strategy engine encounters partial orders during rebalancing:

**Direct Approach** (Simplified):
1. **Identify unhealthy partials**: Detect any partial orders below the 5% dust threshold on each side
2. **Mark for consolidation**: Flag partials as needing attention in the next rebalance cycle
3. **Fund-driven grid rebuild**: Rather than complex slot-by-slot merge/split logic, the entire grid is regenerated based on current total funds (including proceeds from fills)
4. **Natural redistribution**: The rebuilt grid automatically sizes all orders (including those replacing consolidation candidates) using the Ideal Grid sizing formula
5. **Spread maintenance**: The target spread gap remains constant at `targetSpreadPercent`—no dynamically inflated corrections

**Why This Works**:
- **Simpler code path**: No merge vs. split decision logic
- **Fund-safe**: Rebuild uses only available funds; orders that can't be sized are skipped
- **Constant spread**: The spread gap size stays fixed, improving predictability
- **Minimal blockchain interaction**: Grid regeneration happens once per consolidation event (not per partial)

### 4.3 Fund Dynamics During Consolidation

When consolidating partials:

1. **Proceeds become available**: Fill proceeds from the partial are added to `chainFree`
2. **Grid regenerates once**: A single rebalance cycle recalculates all order sizes based on total funds
3. **Partial slot replaced naturally**: The new ideal grid may place a fresh order at the partial's price, or skip it if insufficient funds
4. **No special "doubling" flags**: All slots are treated uniformly—no side-specific bonuses or penalties

**Boundary Behavior**:
- The boundary index shifts with each fill (as before) to follow market movement
- Grid slots are reassigned based on the new boundary and available funds
- No additional spread-widening corrections triggered by partial consolidation

**Fund Consumption**:
Only the net sizing operations consume funds. Since partials are absorbed into the grid rebuild, fund impact is purely from the new order placements in the regenerated grid.

---

## 5. Fee Management

The bot manages two types of fees: **Blockchain Fees** (BTS) and **Market Fees** (Asset deduction).

### 5.1 BTS Fees (Blockchain Operations)
BitShares charges fees for `limit_order_create` and `limit_order_cancel`.

-   **Reservation** (`BTS_RESERVATION_MULTIPLIER` in `constants.ts::FEE_PARAMETERS`):
    $$Reserve = N_{active} \times BTS\_RESERVATION\_MULTIPLIER$$
    *(Default: 5× per order — covers create, rotate (cancel+place), update, and cancel over the order's lifetime)*

-   **Settlement (`deductBtsFees`):**
    1.  Check `Funds.btsFeesOwed`.
    2.  If sufficient `chainFree` available: deduct full amount atomically.
    3.  If insufficient: defer settlement and retry when funds become available.

### 5.2 Market Fees (Trade Cost)
These are deducted from the *proceeds* of a fill.

-   **Maker (Limit Orders):** Typically lower fee (e.g., 0.1%).
    -   **Rebate:** On BitShares, Makers often get a fee rebate on cancellation (vesting).
-   **Taker (Market Orders):** Typically higher fee.
-   **Calculation (`processFilledOrders`):**
    ```javascript
    GrossProceeds = Size * Price
    NetProceeds = GrossProceeds - (GrossProceeds * FeePercent)
    ```

---

## 5.3 BTS Fee Object Structure

For BTS fees, the system returns a structured object (not a simple number) with multiple fields for accounting precision.

**Location**: `modules/order/utils/system.ts::getAssetFees()`

### BTS Fee Object (Always Object)

```javascript
getAssetFees('BTS', amount)
// Returns:
{
    netProceeds: 45500,      // proceeds after fee deduction (amount + refund)
    total: 45500,            // aliased to netProceeds for downstream use
    refund: 450,             // maker refund amount (0 for taker)
    isMaker: true            // Flag: is this a maker fee?
}
```

### netProceeds Calculation

**For Makers** (isMaker = true, gets 90% rebate):
```
netProceeds = assetAmount + (creationFee * 0.9)
// Example: 45,000 asset + (500 fee * 0.9 refund) = 45,450
```

**For Takers** (isMaker = false, no rebate):
```
netProceeds = assetAmount
// Example: 45,000 asset (no refund) = 45,000
```

### Non-BTS Fees (Unchanged)

Non-BTS assets continue to return simple numbers:

```javascript
getAssetFees('IOB.XRP', 1000)
// Returns: 990  (number, not object)

getAssetFees('USD')
// Returns: 995  (number, not object)
```

### Backwards Compatibility

Code can safely detect the fee type:

```javascript
// Check if BTS (object) or asset (number)
if (typeof feeInfo === 'object') {
    // BTS: Use netProceeds field
    const proceeds = feeInfo.netProceeds;
} else {
    // Asset: Use direct number
    const proceeds = assetAmount - feeInfo;
}

// OR use older fields (still present)
const legacyFee = feeInfo.createFee;  // Works for both old and new code
```

---

## 5.4 BUY Side Sizing & Fee Accounting

**Problem Fixed**: BUY side fee calculations incorrectly applied fees to base asset instead of quote asset.

**Solution**: Corrected fee accounting with proper asset assignment.

### Fee Application by Side

| Side | Asset | Calculation | Notes |
|------|-------|-------------|-------|
| **BUY** | Quote (assetB) | Fee deducted from `buyFree` | Buyers pay in quote currency |
| **SELL** | Base (assetA) | Fee deducted from `sellFree` | Sellers pay in base currency |

### Example Scenario

```
Trading pair: XRP (base) / USD (quote)

BUY Order Fills:
- Receives: 1000 XRP
- Pays: 45,000 USD
- Fee: 500 USD (0.1% of 45,500 total)
- Net proceeds: 45,000 USD (quoted asset reduced by fee)

SELL Order Fills:
- Receives: 45,000 USD
- Pays: 1000 XRP
- Fee: 1 XRP (0.1% of 1000 total)
- Net proceeds: 999 XRP (base asset reduced by fee)
```

### Maker Refund Impact on BUY Orders

For BUY orders that are makers:

```javascript
// Market fill amount: 45,500 USD worth
// Maker fee: 500 USD (0.1%)
// Maker refund: 90% of 500 = 450 USD back

// Net proceeds to chainFree:
// - Deposit: 45,500 USD (market received)
// - Fee paid: -500 USD
// - Refund received: +450 USD
// - Final: 45,450 USD credited to buyFree
```

**Impact**: Ensures internal ledgers match blockchain totals exactly, preventing accounting drift from fee variances.

---

## 5.5 Precision & Quantization

**Problem**: Floating-point arithmetic accumulates rounding errors over many calculations. After dozens of order size calculations, price derivations, and fund allocations, float values drift from their true blockchain integer representations, causing mismatches between internal state and on-chain reality.

**Solution**: Centralized quantization utilities that eliminate float accumulation by round-tripping through blockchain integer representation.

### 5.5.1 Core Quantization Functions

**Location**: `modules/order/utils/math.ts` (line 237)

#### `quantizeFloat(value, precision)` - Eliminate Accumulation Errors

Converts float → blockchain int → float to "snap" values to precision boundaries.

```javascript
/**
 * Quantize a float value by round-tripping through blockchain integer representation.
 * Converts float → blockchain int (satoshi-level precision) → float.
 * Eliminates floating-point accumulation errors.
 *
 * @param {number} value - Float value to quantize (e.g., 45.123456789)
 * @param {number} precision - Asset precision (e.g., 8 for satoshis)
 * @returns {number} Quantized float value (e.g., 45.12345679)
 */
function quantizeFloat(value, precision) {
    return blockchainToFloat(floatToBlockchainInt(value, precision), precision);
}

// Example:
// Input: 45.123456789 (accumulated float error)
// Step 1: Float → Int: 45.123456789 * 10^8 = 4512345678.9 → rounds to 4512345679
// Step 2: Int → Float: 4512345679 / 10^8 = 45.12345679 (corrected!)
```

**Use Cases:**
- After fund allocation calculations (prevent 0.000000001 drift)
- When rounding order sizes to blockchain precision
- Before storing prices for comparison operations
- After grid divergence calculations

#### `normalizeInt(value, precision)` - Ensure Integer Alignment

Converts int → float → int to ensure the integer aligns with precision boundaries.

```javascript
/**
 * Normalize an integer value by round-tripping through float representation.
 * Converts int → float (readable format) → blockchain int.
 * Ensures the integer aligns with precision boundaries.
 * Used for precision-aware comparisons.
 *
 * @param {number} value - Integer value (e.g., 4512345679)
 * @param {number} precision - Asset precision
 * @returns {number} Normalized integer value
 */
function normalizeInt(value, precision) {
    return floatToBlockchainInt(blockchainToFloat(value, precision), precision);
}

// Example: Ensure consistency in size comparisons
const currentSizeInt = 4512345679;
const idealSizeInt = 4512345679;
const normalized = normalizeInt(currentSizeInt, 8);
// Returns normalized value for consistent == comparisons
```

**Use Cases:**
- Ensuring order sizes align to blockchain satoshi boundaries
- Normalizing fund totals before invariant checks
- Preparing sizes for blockchain transaction encoding

### 5.5.2 Consolidation Impact

Previously, five separate quantization implementations existed:
- `dexbot_class.ts` - Manual rounding logic
- `order.ts` - Custom precision handling
- `strategy.ts` - Divergent rounding approach
- `chain_orders.ts` - Different quantization pattern
- `export.ts` - Isolated float conversions

**After Consolidation:**
✅ Single source of truth (`math.ts`)
✅ Consistent precision handling across all modules
✅ Reduced regression risk (tested once, used everywhere)
✅ Eliminated subtle float accumulation bugs
✅ All 34+ test suites pass with zero regressions

### 5.5.3 Precision Best Practices

| Scenario | Function | Example |
|----------|----------|---------|
| **Calculate order size** | `quantizeFloat()` | `quantizeFloat(45.123456789, 8)` → Snap to satoshi |
| **Compare sizes** | `normalizeInt()` | Ensure both sides use same integer representation |
| **Fund allocation** | `quantizeFloat()` | After geometric distribution, eliminate drift |
| **Price derivation** | `quantizeFloat()` | Pool/market price calculations prone to float errors |
| **Validate blockchain match** | `normalizeInt()` | Check: `normalizeInt(internal) === normalizeInt(chain)` |

### 5.5.4 Relationship to Fund Validation

The corrected fund validation in `_validateOperationFunds()` uses quantized values:

```javascript
// Check: Does required amount fit in available balance?
const availableBalance = snap.chainFreeSell;  // Quantized by accounting
const requiredAmount = quantizeFloat(totalRequired, precision);  // Quantize for comparison

if (requiredAmount > availableBalance) {
    // Reject batch before broadcasting
    return { valid: false, reason: 'Insufficient funds' };
}
```

This prevents the bug where `available = chainFree + required` created a tautology (`required > chainFree + required` always false). Quantized comparisons now accurately reflect blockchain constraints.

---

## 6. Safety & Invariants

The `Accountant` enforces strict mathematical invariants to detect bugs or manual interference. Invariants are checked by `_verifyFundInvariants()` after every blockchain sync cycle. When a violation is detected, the system logs a `CRITICAL` error and attempts automatic recovery via `_recalculateFromBlockchain()` — resetting internal state to match on-chain reality. If the grid lock is held (mid-rebalance), recovery is deferred until the lock is released. The bot continues operating throughout; it does **not** halt on invariant violations.

### 6.1 The Equality Invariant
Total funds on chain must equal free plus committed.
$$Total_{chain} = Free_{chain} + Committed_{chain}$$

This is the primary drift detector. A mismatch means the bot's internal ledger has diverged from blockchain reality — typically caused by a missed fill event, a double-credited orphan, or a fee deducted from the wrong side. Recovery resets `accountTotals` from the live blockchain balances.

### 6.2 The Ceiling Invariant
Grid commitment cannot exceed total wealth.
$$Committed_{grid} \leq Total_{chain}$$

A violation here means the grid has allocated more capital than actually exists on-chain. This can happen if an order was cancelled externally (outside the bot) or if a fill was processed but the commitment was never released. Recovery rebuilds committed totals by walking the current grid state.

### 6.3 Race Condition Protection (TOCTOU)
To prevent "Time-of-Check to Time-of-Use" errors:
1.  **Locking:** `AsyncLock` prevents concurrent updates to the same order.
2.  **Atomic Deduct:** `tryDeductFromChainFree` checks *and* subtracts in a single synchronous step.
3.  **Bootstrapping:** Fills arriving during startup (`isBootstrapping=true`) are queued until the grid is fully reconciled.

---
*Technical Reference for DEXBot2 v1.0.13 release*
