/**
 * modules/order/grid_reconcile_internal.ts - Internal helpers for grid reconciliation
 *
 * Extracted from grid_reconcile.ts for file-size management.
 * All helpers are prefixed with _ and are NOT part of the public API.
 */



import { ORDER_TYPES, ORDER_STATES, TIMING, BTS_PRECISION } from '../constants.js';
import { readOpenOrdersGuarded } from '../chain_orders.js';
import { getMinOrderSize, getAssetFees, getAssetFeesSafe, blockchainToFloat, findCrossedOrder, resolveGapBand, isSlotInRail, priceSlotEqual } from './utils/math.js';
import { isOrderPlaced, parseChainOrder, buildCreateOrderArgs, buildOutsideInPairGroups, extractBatchOperationResults, chainOrderMatchesSlot, getSideBudget, calculateBudgetedSizes, getActiveOrdersTotal, convertToSpreadPlaceholder, isOrderGoneErrorMessage, clearDuplicateOrphanDetection } from './utils/order.js';
import { resolveAccountRef } from './utils/system.js';
import * as Format from './format.js';
import { getErrorMessage } from '../utils/errors.js';

function computePlacementPriceCollision(manager: any, gridOrder: any): any {
    const precision = gridOrder.type === ORDER_TYPES.SELL ? manager.assets.assetA.precision : manager.assets.assetB.precision;
    for (const o of manager.orders.values()) {
        if (!isOrderPlaced(o) || o.id === gridOrder.id) continue;
        if (priceSlotEqual(o.price, gridOrder.price, precision)) return o;
    }
    return null;
}

/**
 * Crossing-placement guard for startup reconcile placements (relocations
 * and creates): a placement at gridOrder.price must not cross an
 * opposite-side live order — either a master order or a still-unmatched
 * chain order (orphan). Phase-2's cancels-first ordering removes most
 * straddlers, but a FAILED cancel stays live on the chain AND in
 * manager.orders, so this check refuses to re-price or create across it
 * (incident class: a re-priced order self-traded against a live
 * opposite-side order during the broadcast window).
 *
 * @param {Object} manager - OrderManager instance (orders Map, assets).
 * @param {Object} gridOrder - Target grid slot (price, type).
 * @param {string|null} excludeChainOrderId - Chain order id to exempt (the
 *   order being relocated itself; matched both as a master orderId and as
 *   an unmatched-chain-order chainOrderId).
 * @returns {Object|null} The first crossed live order, or null.
 */
function computePlacementCrossing(manager: any, gridOrder: any, excludeChainOrderId: any = null): any {
    const price = gridOrder?.price;
    const type = gridOrder?.type;
    if (price == null || type == null) return null;
    const candidates: any[] = manager.orders instanceof Map ? [...manager.orders.values()] : [];
    if (Array.isArray(manager._lastUnmatchedChainOrders)) {
        for (const o of manager._lastUnmatchedChainOrders) {
            if (o && o.type != null && o.price != null) candidates.push(o);
        }
    }
    return findCrossedOrder(
        candidates,
        price,
        type,
        manager.assets,
        (o: any) => {
            const oid = o?.orderId || o?.chainOrderId;
            return o && oid && o.price != null
                && (!excludeChainOrderId || oid !== excludeChainOrderId);
        }
    );
}

/**
 * Count active orders on the grid for a given type.
 * @param {Object} manager - OrderManager instance.
 * @param {string} type - ORDER_TYPES value.
 * @returns {number} Count of active and partial orders with orderId.
 * @private
 */
function _countActiveOnGrid(manager: any, type: any): number {
    const active = manager.getOrdersByTypeAndState(type, ORDER_STATES.ACTIVE).filter((o: any) => o && o.orderId);
    const partial = manager.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter((o: any) => o && o.orderId);
    return active.length + partial.length;
}

/**
 * Re-derive ideal budgeted sizes for every in-rail slot on a side by mirroring
 * the strategy's full-side sizing (getSideBudget + calculateBudgetedSizes).
 * Built once per _pickVirtualSlotsToActivate call to keep the pick loop O(n)
 * (callers look up derived size by slot id).
 *
 * This handles the "replay the grid shift" case: when a boundary-adjacent slot
 * was virtualized with size 0 by stale-order cleanup (recoverExplicitStaleOrders),
 * it is skipped by the size >= effectiveMin filter and never re-placed, so the
 * reconcile backfills far-end slots instead of the boundary. Re-deriving the
 * size from the live fund snapshot restores a real size for such slots so they
 * become pickable and get re-placed at the boundary.
 *
 * Returns an empty map when the side budget cannot be derived (no funds
 * snapshot, no weight distribution, non-positive budget) — callers then fall
 * through to the stored size, preserving legacy behavior.
 *
 * @param {Object} manager - OrderManager instance.
 * @param {string} type - ORDER_TYPES value.
 * @returns {Map<string, number>} Derived budgeted size keyed by slot id.
 * @private
 */
function _deriveBudgetedSideSizes(manager: any, type: any): Map<string, number> {
    const derived = new Map<string, number>();
    if (typeof manager?.getChainFundsSnapshot !== 'function') return derived;
    const weightDist = manager.config?.weightDistribution;
    if (!weightDist) return derived;

    let funds;
    try {
        funds = manager.getChainFundsSnapshot();
    } catch (e: any) {
        return derived;
    }
    if (!funds) return derived;

    const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';
    const totalTarget = getActiveOrdersTotal(manager.config);
    const budget = getSideBudget(side, funds, manager.config, totalTarget);
    if (!(budget > 0)) return derived;

    // Include every in-rail slot that belongs to this side by geometry.  Empty
    // slots are stored SPREAD (side-neutral) after normalization, so a plain
    // `o.type === type` filter would exclude them and they'd never receive a
    // re-derived size (staying un-pickable).  Only in-rail slots participate in
    // the side budget; gap-band slots must not absorb a share.
    //
    // When boundary is unknown (null), geometry cannot classify an empty slot
    // to a rail — the safe action is to not activate it (under-funded rail
    // temporarily) rather than guess a side.  Only accept concrete BUY/SELL
    // types in that case; this mirrors pre-commit behavior where the type
    // filter was the only guard.
    const resolved = resolveGapBand(manager);
    const boundaryKnown = resolved.boundaryIdx !== null && resolved.sellStartIdx !== null;
    const inSideRail = (o: any): boolean => isSlotInRail(resolved.boundaryIdx, resolved.gapSlots, type, o);
    const typeFilter = boundaryKnown
        ? (o: any) => o && o.price != null && (o.type === type || o.type === ORDER_TYPES.SPREAD)
        : (o: any) => o && o.price != null && o.type === type;
    const allSideSlots = (Array.from(manager.orders.values()) as any[])
        .filter(typeFilter)
        .filter(inSideRail)
        .sort((a: any, b: any) => a.price - b.price);
    if (allSideSlots.length === 0) return derived;

    let sizes;
    try {
        sizes = calculateBudgetedSizes(
            allSideSlots,
            side,
            budget,
            weightDist[side],
            manager.config.incrementPercent,
            manager.assets
        );
    } catch (e: any) {
        return derived;
    }

    allSideSlots.forEach((s: any, i: number) => {
        derived.set(s.id, (Number(sizes?.[i]) || 0));
    });
    return derived;
}

/**
 * Pick virtual slots to activate based on type and count.
 * @param {Object} manager - OrderManager instance.
 * @param {string} type - ORDER_TYPES value.
 * @param {number} count - Number of slots to pick.
 * @returns {Array<Object>} Array of picked virtual slots.
 * @private
 */
function _pickVirtualSlotsToActivate(manager: any, type: any, count: any): any[] {
    if (count <= 0) return [];

    // Boundary geometry: slots in the spread band (between boundary and
    // sellStart) must never be activated as BUY/SELL — an order placed there
    // would sit inside the gap and remove the spread. The SPREAD GUARD keeps
    // such slots typed BUY/SELL (never SPREAD+ACTIVE), so a VIRTUAL sell left
    // behind by a rotation/rebalance could otherwise be re-picked here and
    // placed back inside the gap. Filter by geometry (shared
    // MathUtils.isSlotInRail helper), not just type.
    const resolved = resolveGapBand(manager);
    const boundaryKnown = resolved.boundaryIdx !== null && resolved.sellStartIdx !== null;
    const inRail = (slot: any): boolean => isSlotInRail(resolved.boundaryIdx, resolved.gapSlots, type, slot);

    // CRITICAL FIX: Filter by type BEFORE sorting.
    // Only get slots of the requested type (SELL or BUY), not a mix.  Empty
    // (size-0 VIRTUAL) slots are normalized to SPREAD everywhere they are
    // created (convertToSpreadPlaceholder) so the side-neutral representation
    // never misleads selection; accept SPREAD-typed slots that sit in this
    // side's rail (the inRail geometry filter below excludes gap-band slots).
    // When boundary is unknown, geometry cannot classify an empty — only
    // accept concrete BUY/SELL types (safe: don't activate what we can't place).
    const typeFilter = boundaryKnown
        ? (slot: any) => slot && (slot.type === type || slot.type === ORDER_TYPES.SPREAD)
        : (slot: any) => slot && slot.type === type;
    // Keep-low BUY selection (mirrors strategy.ts farthest-first window):
    // BUY candidates are limited to the BOTTOM `count` slots of the rail
    // (farthest below market). The MIN_BUY_USDT floor then filters WITHIN
    // that window — a sub-floor slot is skipped WITHOUT walking up the rail,
    // otherwise the floor would redirect selection to the heavier
    // boundary-adjacent slots (i.e. buying near the market, the exact
    // behavior this window exists to prevent). Unfunded bottom slots simply
    // stay virtual and their funds remain free. SELL keeps closest-first.
    // MIN_BUY_USDT floor: a BUY whose notional (size × price) is below the
    // floor is skipped — same constant as strategy.ts / manager.ts guard.
    const MIN_BUY_USDT = 0.75;
    const slotsOfType = (Array.from(manager.orders.values()) as any[])
        .filter(typeFilter)
        .filter(inRail)
        .sort((a: any, b: any) => a.price - b.price);
    const candidates = type === ORDER_TYPES.BUY
        ? slotsOfType.slice(0, count)
        : slotsOfType;

    let effectiveMin = 0;
    try {
        effectiveMin = getMinOrderSize(type, manager.assets);
    } catch (e: any) { effectiveMin = 0; }

    const valid: any[] = [];
    // Derived budgeted size per slot, built once (O(n)) so below-min lookups
    // don't recompute full-side sizing for every candidate (avoid O(n²)).
    const derivedSizes = _deriveBudgetedSideSizes(manager, type);
    for (const slot of candidates) {
        if (valid.length >= count) break;
        if (!slot.orderId && slot.state === ORDER_STATES.VIRTUAL) {
            // Role invariant: Only pick slots that make sense for this type based on current market pivot
            // (Strategy will enforce this strictly, but we filter here for cleaner activation)
            const storedSize = Number(slot.size) || 0;
            let effectiveSize = storedSize;

            // Replay the grid shift: a boundary-adjacent slot virtualized with
            // size 0 by stale-order cleanup is un-pickable (below effectiveMin)
            // and never re-placed, so the reconcile backfills far-end slots
            // instead. Re-derive its budgeted size so it becomes pickable and
            // gets re-placed at the boundary with a real, funded size.
            if (effectiveSize < effectiveMin) {
                const derived = derivedSizes.get(slot.id);
                if (derived != null && derived >= effectiveMin) {
                    effectiveSize = derived;
                }
            }

            if (slot.id && effectiveSize >= effectiveMin) {
                // MIN_BUY_USDT floor for BUY activations: sub-floor slots are
                // skipped in place (window is fixed to the rail bottom — no
                // walk-up toward the boundary).
                if (type === ORDER_TYPES.BUY) {
                    // BUY size is in quote (USDT) — the size IS the notional.
                    const notional = Number(effectiveSize);
                    if (notional < MIN_BUY_USDT) {
                        manager.logger?.log?.(
                            `[ACTIVATE] skip ${slot.id} @${Number(slot.price).toPrecision(4)} ` +
                            `size=${notional.toFixed(3)} USDT < ${MIN_BUY_USDT}`,
                            'info'
                        );
                        continue;
                    }
                }
                // Re-type the picked slot to the activation side: empty slots are
                // stored SPREAD (side-neutral), but an order being placed here must
                // carry the concrete BUY/SELL rail type (SPREAD+ACTIVE is illegal,
                // and buildCreateOrderArgs derives the sell/receive assets from the
                // type). Keep any existing size override.
                valid.push({
                    ...(effectiveSize === storedSize ? slot : { ...slot, size: effectiveSize }),
                    type,
                });
            }
        }
    }

    if (type === ORDER_TYPES.BUY) {
        manager.logger?.log?.(
            `[ACTIVATE] ${type}: window=${candidates.length} picked=${valid.length} ` +
            `first=${candidates[0]?.id ?? 'n/a'}@${Number(candidates[0]?.price || 0).toPrecision(4)} ` +
            `firstSize=${Number(candidates[0]?.size || 0).toFixed(2)} firstState=${candidates[0]?.state ?? 'n/a'} firstOrderId=${candidates[0]?.orderId ?? 'none'}`,
            'info'
        );
    }

    return valid;
}


function _getStartupSideComparators(orderType: any, assets: any): { sortUpdateComparator: (a: any, b: any) => number; sortExcessCancelComparator: (a: any, b: any) => number; sortMatchedCancelComparator: (a: any, b: any) => number } {
    const isSell = orderType === ORDER_TYPES.SELL;

    const sortUpdateComparator = isSell
        ? (a: any, b: any) => (parseChainOrder(a, assets)?.price || 0) - (parseChainOrder(b, assets)?.price || 0)
        : (a: any, b: any) => (parseChainOrder(b, assets)?.price || 0) - (parseChainOrder(a, assets)?.price || 0);

    const sortExcessCancelComparator = isSell
        ? (a: any, b: any) => (b.parsed.price || 0) - (a.parsed.price || 0)
        : (a: any, b: any) => (a.parsed.price || 0) - (b.parsed.price || 0);

    const sortMatchedCancelComparator = isSell
        ? (a: any, b: any) => (b.price || 0) - (a.price || 0)
        : (a: any, b: any) => (a.price || 0) - (b.price || 0);

    return {
        sortUpdateComparator,
        sortExcessCancelComparator,
        sortMatchedCancelComparator,
    };
}

/**
 * Detect if grid edge is fully occupied with active orders.
 * When all outermost (furthest from market) orders are ACTIVE with orderId,
 * we're at grid edge and all balance is committed to those orders.
 *
 * @param {Object} manager - OrderManager instance
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} updateCount - Number of orders being updated
 * @returns {boolean} true if edge orders are all active
 * @private
 */
function _isGridEdgeFullyActive(manager: any, orderType: any, updateCount: any): boolean {
    if (!manager || updateCount <= 0) return false;

    // Get all orders of this type
    const allOrders: any[] = (Array.from(manager.orders.values()) as any[]).filter((o: any) => o.type === orderType);
    if (allOrders.length === 0) return false;

    // Sort: for BUY (highest to lowest price), for SELL (lowest to highest)
    // This puts market edge first, grid edge (furthest) last
    const sorted = orderType === ORDER_TYPES.BUY
        ? allOrders.sort((a: any, b: any) => (b.price || 0) - (a.price || 0))  // Buy: high to low price
        : allOrders.sort((a: any, b: any) => (a.price || 0) - (b.price || 0));  // Sell: low to high price

    // Get the outermost orders (last N in sorted = furthest from market)
    const outerEdgeCount = Math.min(updateCount, sorted.length);
    const edgeOrders = sorted.slice(-outerEdgeCount);

    // Check if ALL edge orders are ACTIVE (placed on blockchain)
    // Empty array check prevents vacuous truth: every([]) returns true
    if (edgeOrders.length === 0) return false;
    const allEdgeActive = edgeOrders.every((o: any) => isOrderPlaced(o));

    return allEdgeActive;
}

/**
 * Find the largest order among those being updated.
 * Returns both the order and its index in unmatchedOrders for pairing with gridOrders.
 * @param {Array<Object>} unmatchedOrders - Array of unmatched on-chain orders
 * @param {number} updateCount - Number of orders being updated (first N)
 * @returns {{order: Object, index: number}|null} Largest order and its index, or null if none found
 * @private
 */
function _findLargestOrder(unmatchedOrders: any, updateCount: any): { order: any; index: number } | null {
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const ordersToCheck = unmatchedOrders.slice(0, updateCount);
    let largestOrder = null;
    let largestIndex = -1;
    let largestSize = 0;

    for (let i = 0; i < ordersToCheck.length; i++) {
        const order = ordersToCheck[i];
        const size = Number(order.for_sale) || 0;
        if (size > largestSize) {
            largestSize = size;
            largestOrder = order;
            largestIndex = i;
        }
    }

    return largestIndex >= 0 ? { order: largestOrder, index: largestIndex } : null;
}

/**
 * Cancel the largest unmatched order to free up maximum funds.
 * This is more efficient than reducing to size 1 and then updating twice.
 * Returns the grid slot index and grid order that needs to be filled.
 * @param {Object} params - Destructured parameters
 * @param {Function} params.chainOrders - Chain order query function
 * @param {string} params.account - Account ID or name
 * @param {string} params.privateKey - Active/owner private key
 * @param {Object} params.manager - OrderManager instance
 * @param {Array<Object>} params.unmatchedOrders - Unmatched on-chain orders
 * @param {number} params.updateCount - Number of orders being updated
 * @param {string} params.orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {boolean} params.dryRun - If true, skip actual cancellation
 * @returns {Promise<{gridIndex: number, gridOrder: Object}|null>} Grid slot info or null
 * @private
 */
async function _cancelLargestOrder({ chainOrders, account, privateKey, manager, unmatchedOrders, updateCount, orderType, dryRun, planOnly = false }: { chainOrders: any; account: any; privateKey: any; manager: any; unmatchedOrders: any; updateCount: any; orderType: any; dryRun: any; planOnly?: boolean; }): Promise<{ index: number; orderType: any; chainOrderObj?: any } | null> {
    if (dryRun) return null;
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const logger = manager && manager.logger;

    // Find the largest order among those being updated
    const largestInfo = _findLargestOrder(unmatchedOrders, updateCount);
    if (!largestInfo) return null;

    const { order: largestOrder, index: largestIndex } = largestInfo;
    const originalSize = Number(largestOrder.for_sale) || 0;
    const orderId = largestOrder.id;

    logger?.log?.(
        `Grid edge detected: cancelling largest order ${orderId} (size ${originalSize}) to free up funds`,
        'info'
    );

    if (planOnly) {
        // In planOnly mode, return the index and chain order info so the caller
        // can plan the replacement create. Actual cancellation happens in Phase 2.
        return { index: largestIndex, orderType, chainOrderObj: largestOrder };
    }

    try {
        // Cancel the largest order on blockchain and release untracked funds.
        await _cancelChainOrder({
            chainOrders,
            account,
            privateKey,
            manager,
            chainOrderId: orderId,
            chainOrderObj: largestOrder,
            releaseUntrackedFunds: true,
            dryRun,
        });
        logger?.log?.(`Cancelled largest order ${orderId}`, 'info');

        // Mark for removal from unmatched list (handled by caller)
        // Return info needed to create this order fresh later
        return { index: largestIndex, orderType };
    } catch (err: any) {
        logger?.log?.(`Warning: Could not cancel largest order ${orderId}: ${getErrorMessage(err)}`, 'warn');
        return null;
    }
}

/**
 * Create a new chain order from a grid slot.
 *
 * @private
 * @requires _gridLock MUST be held by caller — the collision check and
 *   subsequent create are not atomic otherwise.
 *
 * @param {Object} params - Creation parameters.
 * @param {Object} params.chainOrders - Chain orders module.
 * @param {string} params.account - Account name.
 * @param {string} params.privateKey - Private key.
 * @param {Object} params.manager - OrderManager instance.
 * @param {Object} params.gridOrder - Grid order object.
 * @param {boolean} params.dryRun - Whether to simulate.
 * @returns {Promise<void>}
 */
async function _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun, extraOptions = {} }: { chainOrders: any; account: any; privateKey: any; manager: any; gridOrder: any; dryRun: any; extraOptions?: any }): Promise<string | null> {
    if (dryRun) return null;

    // ATOMIC RE-VERIFICATION: Ensure slot is still virtual and hasn't been filled by recovery sync.
    // This protects the same slot (own orderId). The collision check below protects
    // against other slots at the same price — the two are complementary.
    const currentSlot = manager.orders.get(gridOrder.id);
    if (currentSlot && currentSlot.orderId) {
        manager.logger?.log?.(`[_createOrderFromGrid] SKIP: Slot ${gridOrder.id} already has orderId ${currentSlot.orderId}`, 'warn');
        return null;
    }

    const createPrice = gridOrder.price;

    // CROSSING-PLACEMENT GUARD: a create must not cross an opposite-side
    // live order (master or unmatched orphan) — see computePlacementCrossing.
    // Checked BEFORE the same-price collision guard so a near-equal
    // opposite-side order is reported as a crossing, not a collision.
    const crossed = computePlacementCrossing(manager, gridOrder, null);
    if (crossed) {
        manager.logger?.log?.(
            `[_createOrderFromGrid] SKIP (STARTUP-CROSS-GUARD): Create for ${gridOrder.id} at ` +
            `${Format.formatPrice6(createPrice)} crosses live ${crossed.type} ` +
            `${crossed.id || crossed.chainOrderId || 'chain'} (${crossed.orderId || crossed.chainOrderId}) ` +
            `@${Format.formatPrice6(crossed.price)}`,
            'warn'
        );
        return null;
    }

    // Price collision guard: reject if another placed order already exists at this price level.
    const priceCollision = computePlacementPriceCollision(manager, gridOrder);
    if (priceCollision) {
        manager.logger?.log?.(
            `[_createOrderFromGrid] SKIP: Create for ${gridOrder.id} at ${Format.formatPrice6(createPrice)} ` +
            `collides with placed order ${priceCollision.id} (${priceCollision.orderId}) at ${Format.formatPrice6(priceCollision.price)}`,
            'warn'
        );
        return null;
    }

    const { amountToSell, sellAssetId, minToReceive, receiveAssetId } = buildCreateOrderArgs(
        gridOrder,
        manager.assets.assetA,
        manager.assets.assetB
    );

    const result = await chainOrders.createOrder(
        account,
        privateKey,
        amountToSell,
        sellAssetId,
        minToReceive,
        receiveAssetId,
        null,
        false,
        extraOptions
    );

    if (result && result.skipped) {
        const logger = manager && manager.logger;
        logger?.log?.(`[_createOrderFromGrid] Skipped slot ${gridOrder.id}: order amounts too small to place on-chain`, 'warn');
        return null;
    }

    const operationResults = extractBatchOperationResults(result) || [];
    const chainOrderId = operationResults[0] && operationResults[0][1];

    if (chainOrderId) {
        // Capture chain order ID BEFORE _applySync, so even if _applySync
        // fails (leaving the order unregistered in manager.orders), Phase 3
        // will still know this order was legitimately created and avoid cancelling it.
        const capturedId = chainOrderId;

        try {
            const btsFeeData = getAssetFees('BTS');
            await manager._applySync({
                gridOrderId: gridOrder.id,
                chainOrderId,
                isPartialPlacement: false,
                expectedType: gridOrder.type,
                fee: btsFeeData.createFee
            }, 'createOrder');
        } catch (syncErr: any) {
            const logger = manager && manager.logger;
            logger?.log?.(
                `[_createOrderFromGrid] _applySync failed after successful broadcast for ${capturedId}: ${getErrorMessage(syncErr)}`,
                'error'
            );
            // Run recovery sync to register the orphaned order. If this also
            // fails (or the chain read is empty/truncated), the returned
            // capturedId still prevents Phase 3 cancellation.
            await _recoverSyncFromChain({
                chainOrders,
                manager,
                account,
                logger,
                source: 'createOrder-applySync-failure',
            });
            // Return the captured ID regardless so Phase 3 knows this order was
            // legitimately created and avoids cancelling it.
            return capturedId;
        }

        return capturedId;
    } else {
        // CRITICAL FIX: Recovery sync if order extraction fails
        const logger = manager && manager.logger;
        logger?.log?.(`[_createOrderFromGrid] CRITICAL: createOrder succeeded but chainOrderId extraction failed`, 'error');
        const recovered = await _recoverSyncFromChain({
            chainOrders,
            manager,
            account,
            logger,
            source: 'chainOrderIdExtractionFailure',
        });
        if (!recovered) {
            logger?.log?.(`[_createOrderFromGrid] Recovery sync unavailable; zeroing slot ${gridOrder.id} to prevent duplicate creation`, 'error');
            // Transition the slot to zero-size VIRTUAL to prevent duplicate
            // creation on the next COW cycle. The orphaned chain order will
            // be picked up by the next normal full sync.
            // NOTE: convertToSpreadPlaceholder sets type=SPREAD (not the
            // original BUY/SELL).  This is intentional: an empty VIRTUAL slot
            // is a reusable placeholder that must be side-neutral, matching
            // the assignGridRoles invariant.  The slot will be re-typed to
            // BUY/SELL by geometry when it is next activated.
            // Note: caller does NOT hold _gridLock (Phase 2 runs outside lock),
            // so we acquire it explicitly for the grid mutation.
            try {
                const zeroOrder = convertToSpreadPlaceholder(gridOrder);
                await manager._gridLock.acquire(async () => {
                    await manager._applyOrderUpdate(zeroOrder, 'createOrder-extraction-failure', { skipAccounting: true, fee: 0 });
                });
            } catch (zeroErr: any) {
                logger?.log?.(`[_createOrderFromGrid] Failed to zero slot ${gridOrder.id}: ${getErrorMessage(zeroErr)}`, 'error');
            }
        }
    }
    return null;
}

/**
 * Cancel a chain order and sync with manager.
 * @param {Object} params - Cancellation parameters.
 * @param {Object} params.chainOrders - Chain orders module.
 * @param {string} params.account - Account name.
 * @param {string} params.privateKey - Private key.
 * @param {Object} params.manager - OrderManager instance.
 * @param {string} params.chainOrderId - ID of the chain order to cancel.
 * @param {boolean} params.dryRun - Whether to simulate.
 * @param {Object} [params.chainOrderObj] - Raw chain order object (needed for fund release).
 * @param {boolean} [params.releaseUntrackedFunds=false] - If true, release the cancelled order's
 *   committed funds via addToChainFree. Use only for unmatched chain orders that have no
 *   corresponding ACTIVE/PARTIAL grid slot (where synchronizeWithChain cannot release them).
 * @returns {Promise<void>}
 * @private
 */
async function _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId, dryRun, chainOrderObj, releaseUntrackedFunds = false }: { chainOrders: any; account: any; privateKey: any; manager: any; chainOrderId: any; dryRun: any; chainOrderObj: any; releaseUntrackedFunds?: boolean; }): Promise<void> {
    if (dryRun) return;

    // The snapshot this cancel is based on may be stale: another path (e.g. the
    // sync-layer cancel-only correction) may already have cancelled the order and
    // the wasRecentlyOwnCancelled 5s TTL lapsed before reconcile's Phase-2 ran.
    // When releasing untracked funds, treat "order does not exist" as a successful
    // cancel and still release the capital — otherwise the funds are stranded and
    // the chainTotal = chainFree + chainCommitted invariant is violated. Non-release
    // cancels (matched slots) keep the previous throw-and-log behavior.
    let cancelResult: any = null;
    let orderGone = false;
    try {
        cancelResult = await chainOrders.cancelOrder(account, privateKey, chainOrderId);
    } catch (cancelErr: any) {
        const errMsg = getErrorMessage(cancelErr) || '';
        if (releaseUntrackedFunds && isOrderGoneErrorMessage(errMsg)) {
            orderGone = true;
        } else {
            throw cancelErr;
        }
    }

    if (!orderGone) {
        if (cancelResult?.verifiedAfterFailure) {
            const recovered = await _recoverSyncFromChain({
                chainOrders,
                manager,
                account,
                logger: manager && manager.logger,
                source: 'cancelOrder',
            });
            if (!recovered) {
                // The cancellation was authoritatively confirmed absent inside
                // cancelOrder, but the recovery refetch was skipped (empty/
                // truncated read — ambiguous, so the full sync must NOT run) or
                // failed. The order is provably gone, so apply the local cancel
                // sync to release its capital and clear the slot — same fallback
                // as the dust-cancel path. Skipping it would leave the slot stuck
                // ACTIVE with a chain order that no longer exists.
                await manager._applySync({ orderId: chainOrderId }, 'cancelOrder');
            }
        } else {
            await manager._applySync({ orderId: chainOrderId }, 'cancelOrder');
        }
    }

    // Resolved: forget any persistent-duplicate escalation counter for this orphan.
    clearDuplicateOrphanDetection(chainOrderId);

    // Unmatched chain orders are not represented as ACTIVE/PARTIAL grid slots, so
    // synchronizeWithChain('cancelOrder') cannot release their commitment.
    if (releaseUntrackedFunds && manager.accountant && chainOrderObj) {
        const parsed = parseChainOrder(chainOrderObj, manager.assets);
        if (parsed && parsed.size != null && parsed.size > 0) {
            await manager._fundLock.acquire(async () => {
                await manager.accountant.addToChainFree(parsed.type, parsed.size, 'startup-cancel-unmatched');
            });
        }
    }
}

/**
 * Recovery sync from a fresh chain read, guarded against ambiguous snapshots.
 * An empty read (node may be lagging behind a just-broadcast transaction) and
 * a truncated read (get_full_accounts caps the limit_orders window; fresh
 * orders sort last and are the first entries omitted) are both treated as
 * unreadable: running syncFromOpenOrders on them would let pass-1 phantom
 * cleanup virtualize ACTIVE/PARTIAL slots that are actually live on chain,
 * after which the next cycle re-creates them and duplicates the orders.
 * Returns the fresh orders when the sync ran, null when skipped/failed.
 * @returns {Promise<any[] | null>}
 * @private
 */
async function _recoverSyncFromChain({ chainOrders, manager, account, logger, source, triggerMessage, skipMessage }: {
    chainOrders: any;
    manager: any;
    account: any;
    logger: any;
    source: any;
    triggerMessage?: string;
    skipMessage?: string;
}): Promise<any[] | null> {
    try {
        if (triggerMessage) logger?.log?.(triggerMessage, 'warn');
        const freshChainOrders = await readOpenOrdersGuarded(
            chainOrders,
            resolveAccountRef(manager, account),
            {
                log: (message: string, level: any) => logger?.log?.(message, level),
                label: 'RECOVERY',
                deferEmpty: true,
                timeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
                skipMessage: skipMessage || 'Recovery sync skipped - empty/truncated chain read is ambiguous (node may be lagging, or the get_full_accounts window omitted fresh orders); deferring to next reconcile cycle',
            }
        );
        if (freshChainOrders === null) return null;
        await manager.syncFromOpenOrders(freshChainOrders, {
            skipAccounting: false,
            source,
        });
        return freshChainOrders;
    } catch (syncErr: any) {
        logger?.log?.(`Recovery sync failed: ${getErrorMessage(syncErr)}`, 'error');
        return null;
    }
}

async function _recoverStartupSyncFailure({ chainOrders, manager, account, logger, triggerMessage, source }: { chainOrders: any; manager: any; account: any; logger: any; triggerMessage: any; source: any; }): Promise<any> {
    return _recoverSyncFromChain({
        chainOrders,
        manager,
        account,
        logger,
        source,
        triggerMessage,
        skipMessage:
            'Startup: Recovery sync skipped - empty/truncated chain read is ambiguous (node may be lagging, ' +
            'or the get_full_accounts window omitted fresh orders); deferring to next reconcile cycle',
    });
}

function _refreshStartupUpdatePlans(updatePlans: any, chainOpenOrders: any): any[] {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0) return [];
    const chainById = new Map(
        (Array.isArray(chainOpenOrders) ? chainOpenOrders : [])
            .filter((o: any) => o && o.id)
            .map((o: any) => [o.id, o])
    );

    const refreshed: any[] = [];
    for (const plan of updatePlans) {
        if (!plan?.chainOrderId || !plan?.gridOrder?.id) continue;
        const freshChainOrder = chainById.get(plan.chainOrderId);
        if (!freshChainOrder) continue;
        refreshed.push({
            ...plan,
            chainOrderObj: freshChainOrder,
        });
    }
    return refreshed;
}

function _prepareStartupUpdatePlan(plan: any, manager: any, logger: any): any {
    const chainOrderId = plan?.chainOrderId;
    const gridOrder = plan?.gridOrder;
    if (!chainOrderId || !gridOrder?.id) return null;

    const currentSlot = manager.orders.get(gridOrder.id);
    if (!currentSlot || (currentSlot.orderId && currentSlot.orderId !== chainOrderId)) {
        logger?.log?.(`Startup: Skip update ${chainOrderId} -> ${gridOrder.id}; slot already mapped (${currentSlot?.orderId || 'none'})`, 'debug');
        return null;
    }
    if (currentSlot.orderId === chainOrderId) {
        logger?.log?.(`Startup: Skip update ${chainOrderId} -> ${gridOrder.id}; slot already matched`, 'debug');
        return null;
    }

    const { amountToSell, minToReceive } = buildCreateOrderArgs(
        gridOrder,
        manager.assets.assetA,
        manager.assets.assetB
    );

    // CROSSING-PLACEMENT GUARD: a relocation re-prices the chain order onto
    // the target slot's rail price. It must not cross an opposite-side live
    // order — Phase-2's cancels-first ordering removes most straddlers, but
    // a FAILED cancel stays live on the chain and in manager.orders, and
    // re-pricing across it would self-trade during the broadcast window.
    // Skipping is safe: the order keeps its old commitment and the next
    // reconcile cycle re-aligns once the crossed order is resolved.
    const crossed = computePlacementCrossing(manager, gridOrder, chainOrderId);
    if (crossed) {
        logger?.log?.(
            `[STARTUP-CROSS-GUARD] Skipping relocation update ${chainOrderId} -> ${gridOrder.id}: ` +
            `new ${gridOrder.type} @${Format.formatPrice6(gridOrder.price)} crosses live ` +
            `${crossed.type} ${crossed.id || crossed.chainOrderId || 'chain'} ` +
            `(${crossed.orderId || crossed.chainOrderId}) @${Format.formatPrice6(crossed.price)}; ` +
            `re-align on the next reconcile cycle.`,
            'warn'
        );
        return null;
    }

    return {
        plan,
        chainOrderId,
        gridOrder,
        parsedChain: parseChainOrder(plan.chainOrderObj, manager.assets),
        updateParams: {
            newPrice: gridOrder.price,
            amountToSell,
            minToReceive,
            orderType: gridOrder.type,
        }
    };
}

async function _finalizeStartupUpdate({ manager, preparedUpdate }: { manager: any; preparedUpdate: any }): Promise<void> {
    const { plan, parsedChain } = preparedUpdate;
    if (parsedChain && parsedChain.size > 0 && manager.accountant) {
        await manager._fundLock.acquire(async () => {
            await manager.accountant.addToChainFree(plan.gridOrder.type, parsedChain.size, 'startup-align');
        });
    }

    // Extract deferred_fee from the raw chain order object so the fee
    // lifecycle (cancel refunds, fill maker discounts) reconstructs
    // the correct btsFeeState after a grid reset.
    // deferred_fee from chain is in raw satoshis (BTS precision 5).
    // The fee lifecycle operates in float BTS units, so convert here.
    const rawDeferredFee = plan.chainOrderObj?.deferred_fee != null
        ? Format.toFiniteNumber(plan.chainOrderObj?.deferred_fee, null)
        : null;
    const deferredFeeFloat = rawDeferredFee !== null ? blockchainToFloat(rawDeferredFee, BTS_PRECISION) : null;

    const btsFeeData = getAssetFees('BTS');
    await manager._applySync({
        gridOrderId: plan.gridOrder.id,
        chainOrderId: plan.chainOrderId,
        isPartialPlacement: false,
        expectedType: plan.gridOrder.type,
        fee: btsFeeData.updateFee,
        skipAccounting: false,
        deferredFee: deferredFeeFloat,
    }, 'createOrder');
}

async function _executeStartupUpdateBatch({
    updatePlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    updatePlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<{ executed: boolean; prepared: number; skipped: boolean }> {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0 || dryRun) {
        return { executed: false, prepared: 0, skipped: true };
    }

    if (typeof chainOrders?.buildUpdateOrderOp !== 'function' || typeof chainOrders?.executeBatch !== 'function') {
        throw new Error('chainOrders does not support batch update operations');
    }

    const logger = manager?.logger;
    const prepared: any[] = [];

    for (const plan of updatePlans) {
        const preparedPlan = _prepareStartupUpdatePlan(plan, manager, logger);
        if (!preparedPlan) continue;

        const buildResult = await chainOrders.buildUpdateOrderOp(
            account,
            preparedPlan.chainOrderId,
            preparedPlan.updateParams,
            plan.chainOrderObj || null
        );

        if (!buildResult) {
            logger?.log?.(`Startup: Skip update ${preparedPlan.chainOrderId} -> ${preparedPlan.gridOrder.id}; no blockchain delta`, 'debug');
            continue;
        }

        prepared.push({
            ...preparedPlan,
            op: buildResult.op,
        });
    }

    if (prepared.length === 0) {
        return { executed: false, prepared: 0, skipped: true };
    }

    logger?.log?.(`Startup: Broadcasting update batch (${prepared.length} op${prepared.length > 1 ? 's' : ''})`, 'info');
    await chainOrders.executeBatch(account, privateKey, prepared.map((p: any) => p.op));

    let finalizeFailed = false;
    for (const entry of prepared) {
        if (finalizeFailed) {
            logger?.log?.(`Startup: Skip finalize for ${entry.plan.gridOrder.id} due to prior finalization failure`, 'warn');
            continue;
        }
        try {
            await _finalizeStartupUpdate({ manager, preparedUpdate: entry });
        } catch (finalizeErr: any) {
            logger?.log?.(`Startup: Finalize failed for ${entry.plan.gridOrder.id}: ${getErrorMessage(finalizeErr)}`, 'error');
            finalizeFailed = true;
        }
    }

    if (finalizeFailed) {
        logger?.log?.(`Startup: Batch broadcast succeeded but finalization incomplete — next full sync will reconcile`, 'warn');
    }

    return { executed: true, prepared: prepared.length, skipped: false };
}

async function _executeStartupSingleUpdate({
    plan,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    plan: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<{ executed: boolean; skipped: boolean }> {
    if (dryRun) return { executed: false, skipped: true };
    if (typeof chainOrders?.updateOrder !== 'function') {
        throw new Error('chainOrders.updateOrder is required for sequential update fallback');
    }

    const logger = manager?.logger;
    const prepared = _prepareStartupUpdatePlan(plan, manager, logger);
    if (!prepared) return { executed: false, skipped: true };

    const result = await chainOrders.updateOrder(
        account,
        privateKey,
        prepared.chainOrderId,
        prepared.updateParams
    );

    if (!result) {
        logger?.log?.(`Startup: Skip update ${prepared.chainOrderId} -> ${prepared.gridOrder.id}; no blockchain delta`, 'debug');
        return { executed: false, skipped: true };
    }

    await _finalizeStartupUpdate({ manager, preparedUpdate: prepared });
    return { executed: true, skipped: false };
}

async function _executeStartupSequentialUpdateFallback({
    updatePlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    updatePlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<{ executed: number; skipped: number; failed: number }> {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0 || dryRun) {
        return { executed: 0, skipped: 0, failed: 0 };
    }

    const logger = manager?.logger;

    // Pre-filter: skip plans whose slots were already resolved by the recovery
    // sync that ran after the last failed batch attempt. This avoids flooding
    // the log with "slot already mapped" warnings for every plan.
    const plans = updatePlans.filter((plan: any) => {
        const prepared = _prepareStartupUpdatePlan(plan, manager, logger);
        return prepared !== null;
    });
    if (plans.length === 0) {
        logger?.log?.('Startup: All pending updates already resolved by recovery sync; skipping sequential fallback.', 'warn');
        return { executed: 0, skipped: 0, failed: 0 };
    }

    let queue = plans;
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    logger?.log?.(`Startup: Falling back to sequential updates for ${queue.length} pending order(s)`, 'warn');

    while (queue.length > 0) {
        const plan = queue.shift();
        if (!plan) continue;

        try {
            const result = await _executeStartupSingleUpdate({
                plan,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
            });

            if (result.executed) executed++;
            else skipped++;
        } catch (err: any) {
            failed++;
            logger?.log?.(`Startup: Sequential update failed for ${plan.chainOrderId} -> ${plan.gridOrderId || plan.gridOrder?.id}: ${getErrorMessage(err)}`, 'error');

            const refreshedChainOrders = await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger,
                triggerMessage: `Startup: Triggering recovery sync after sequential update failure for ${plan.chainOrderId}`,
                source: 'startupReconcileSequentialUpdateFailure',
                });

            queue = _refreshStartupUpdatePlans(queue, refreshedChainOrders);
        }
    }

    return { executed, skipped, failed };
}

/**
 * Verify whether an uncertain startup create actually landed on chain, and if
 * so adopt it via a chain sync so the slot is registered with its real orderId.
 * Returns the chain order id when the create landed.
 * Returns the string 'unknown' when the chain state could NOT be verified
 * (read failure, an empty read which is indistinguishable from a lagging
 * node that missed the just-broadcast transaction, or a truncated read whose
 * capped result set omits the fresh create) — the caller must NOT
 * re-broadcast on 'unknown', or a landed order would be duplicated.
 * Returns null only on AUTHORITATIVE absence: a successful non-empty,
 * non-truncated read that contains no matching order. In that case
 * re-broadcasting is safe.
 * @private
 */
async function _adoptPossiblyLandedCreate({
    chainOrders,
    manager,
    account,
    gridOrder,
}: {
    chainOrders: any;
    manager: any;
    account: any;
    gridOrder: any;
}): Promise<string | null | 'unknown'> {
    try {
        // Truncated reads omit the newest limit orders (by_account index
        // order) — exactly the create this check is verifying — and empty
        // reads are indistinguishable from a lagging node that missed the
        // just-broadcast transaction. Both are unverifiable; absence is only
        // authoritative on a clean, non-empty read.
        const freshChainOrders = await readOpenOrdersGuarded(
            chainOrders,
            resolveAccountRef(manager, account),
            {
                deferEmpty: true,
                timeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
            }
        );
        if (freshChainOrders === null) {
            return 'unknown';
        }

        const assets = manager?.assets;
        if (!assets?.assetA || !assets?.assetB) return 'unknown';

        let matched: any = null;
        for (const o of freshChainOrders) {
            const parsed = parseChainOrder(o, assets);
            if (!parsed || parsed.type !== gridOrder.type) continue;
            if (parsed.orderId && Array.from(manager.orders.values()).some((g: any) => g.orderId === parsed.orderId)) continue;
            if (!chainOrderMatchesSlot(parsed, gridOrder, assets)) continue;
            matched = o;
            break;
        }
        if (!matched) return null;

        await manager.syncFromOpenOrders(freshChainOrders, {
            // Accounting enabled: the landed order must be committed in the
            // optimistic balances (VIRTUAL→ACTIVE locks its capital), or the
            // funds appear free while locked on chain — same policy as
            // _recoverStartupSyncFailure and the group-uncertain adoption.
            skipAccounting: false,
            source: 'startup-create-uncertain-adopt',
        });
        // Deduct the create fee: syncFromOpenOrders activates the slot and locks
        // its capital but does not apply the on-chain create cost. The group
        // batch path and the grid_reconcile adoption loop both apply it via
        // _applySync(fee: createFee) — mirror that here so the optimistic
        // balance reflects the real chain cost.
        const btsFeeData = getAssetFeesSafe('BTS');
        await manager._applySync({
            gridOrderId: gridOrder.id,
            chainOrderId: matched.id,
            isPartialPlacement: false,
            expectedType: gridOrder.type,
            fee: btsFeeData?.createFee || 0,
        }, 'createOrder');
        return matched.id || null;
    } catch (adoptErr: any) {
        manager?.logger?.log?.(
            `Startup: Uncertain-create adoption check failed for ${gridOrder?.id}: ${getErrorMessage(adoptErr)}`,
            'warn'
        );
        return 'unknown';
    }
}

/**
 * Flag slots whose CREATE broadcast result was lost (uncertain): the order may
 * be live on chain while the master slot still reads VIRTUAL with a planned
 * size. This durable marker is the ONLY evidence that distinguishes a true
 * sized-VIRTUAL orphan from a normal planned slot, so the persisted grid's
 * loadGrid sanitizer drops sizes only for flagged slots (see grid.ts and
 * docs/CONSOLIDATED_ORPHAN_FIX_SUMMARY.md §3 lineage).
 */
async function _markSlotsCreateUncertain(manager: any, slotIds: any[], logger?: any): Promise<void> {
    if (!manager?.orders || typeof manager.applyGridUpdateBatch !== 'function') return;
    const updates: any[] = [];
    for (const id of slotIds || []) {
        if (!id) continue;
        const slot = manager.orders.get(id);
        if (!slot || slot.orderId || slot.state !== ORDER_STATES.VIRTUAL || slot.createUncertain === true) continue;
        updates.push({ ...slot, createUncertain: true });
    }
    if (updates.length === 0) return;
    try {
        await manager.applyGridUpdateBatch(updates, 'startup-create-uncertain-marker');
    } catch (err: any) {
        logger?.log?.(`Startup: Failed to mark create-uncertain slots: ${getErrorMessage(err)}`, 'warn');
    }
}

async function _createStartupOrderWithHandling({
    chainOrders,
    account,
    privateKey,
    manager,
    gridOrder,
    orderLabel,
    dryRun,
    recovery,
}: {
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    gridOrder: any;
    orderLabel: any;
    dryRun: any;
    recovery: any;
}): Promise<string | null> {
    const maxAttempts = 2;
    let failedWithUncertain = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const chainOrderId = await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
            if (chainOrderId) return chainOrderId;
            return null;
        } catch (err: any) {
            const isUncertain = err?.code === 'BROADCAST_UNCERTAIN' || err?.name === 'BroadcastUncertainError';
            manager?.logger?.log?.(
                `Startup: Failed to create ${orderLabel} (attempt ${attempt}/${maxAttempts}${isUncertain ? ', uncertain broadcast' : ''}): ${getErrorMessage(err)}`,
                'error'
            );

            if (!isUncertain) break;

            failedWithUncertain = true;
            const landed = await _adoptPossiblyLandedCreate({ chainOrders, manager, account, gridOrder });
            if (landed && landed !== 'unknown') {
                manager?.logger?.log?.(
                    `Startup: Uncertain create for ${orderLabel} confirmed on chain (${landed}); adopted via chain sync`,
                    'warn'
                );
                return landed;
            }
            if (landed === 'unknown') {
                // Chain state unverifiable (lagging/empty read). Re-broadcasting
                // now could duplicate an order that actually landed; defer the
                // create to the next startup reconcile cycle instead.
                manager?.logger?.log?.(
                    `Startup: Uncertain create for ${orderLabel} could not be verified on chain; deferring re-broadcast to next reconcile cycle (duplicate-order protection)`,
                    'warn'
                );
                break;
            }
            if (attempt < maxAttempts) {
                manager?.logger?.log?.(
                    `Startup: Uncertain create for ${orderLabel} not found on chain; retrying (authoritative absence verified)`,
                    'warn'
                );
            }
        }
    }

    if (recovery && recovery.triggerMessage && recovery.source) {
        await _recoverStartupSyncFailure({
            chainOrders,
            manager,
            account,
            logger: manager?.logger,
            triggerMessage: recovery.triggerMessage,
            source: recovery.source,
        });
    }
    if (failedWithUncertain) {
        manager?.logger?.log?.(
            `Startup: Create failed for ${orderLabel} after ${maxAttempts} attempt(s); slot kept for next startup reconcile cycle`,
            'warn'
        );
        // Possibly-landed create with no adoptable evidence: mark the slot so
        // a reload's sanitizer treats its size as an orphan candidate instead
        // of a normal planned size (see grid.ts loadGrid).
        await _markSlotsCreateUncertain(manager, [gridOrder?.id], manager?.logger);
    }
    return null;
}

// _extractBatchOperationResults — thin wrapper over shared utility,
// returns empty array (not null) for callers that iterate directly.
function _extractBatchOperationResults(result: any): any[] {
    return extractBatchOperationResults(result) || [];
}

function _resolveGroupRecovery(group: any, fallbackMessage: any, fallbackSource: any): { triggerMessage: any; source: any } {
    for (const plan of group || []) {
        if (plan?.recovery?.triggerMessage && plan?.recovery?.source) {
            return { triggerMessage: plan.recovery.triggerMessage, source: plan.recovery.source };
        }
    }
    return { triggerMessage: fallbackMessage, source: fallbackSource };
}

async function _executeStartupCreateGroupBatch({
    group,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
    groupIndex,
    totalGroups,
}: {
    group: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
    groupIndex: any;
    totalGroups: any;
}): Promise<string[]> {
    if (!Array.isArray(group) || group.length === 0 || dryRun) return [];
    if (typeof chainOrders?.buildCreateOrderOp !== 'function' || typeof chainOrders?.executeBatch !== 'function') {
        throw new Error('chainOrders does not support batch create operations');
    }

    const logger = manager?.logger;
    const prepared: any[] = [];

    for (const plan of group) {
        const gridOrder = plan?.gridOrder;
        if (!gridOrder || !gridOrder.id) continue;

        const currentSlot = manager.orders.get(gridOrder.id);
        if (currentSlot?.orderId) {
            logger?.log?.(`Startup: Skip create ${plan.orderLabel} - slot ${gridOrder.id} already has orderId ${currentSlot.orderId}`, 'warn');
            continue;
        }

        // Price collision guard: reject if another placed order already exists at this price level.
        // The slot-orderId check (above) protects the same slot; this protects against other
        // slots whose price falls within tolerance — the two are complementary.
        const createPrice = gridOrder.price;
        const priceCollision = computePlacementPriceCollision(manager, gridOrder);
        if (priceCollision) {
            logger?.log?.(
                `Startup: Skip create ${plan.orderLabel} - price ${Format.formatPrice6(createPrice)} ` +
                `collides with placed order ${priceCollision.id} (${priceCollision.orderId}) ` +
                `at ${Format.formatPrice6(priceCollision.price)}`,
                'warn'
            );
            continue;
        }

        // CROSSING-PLACEMENT GUARD: a create must not cross an opposite-side
        // live order (master or unmatched orphan) — see computePlacementCrossing.
        const crossed = computePlacementCrossing(manager, gridOrder, null);
        if (crossed) {
            logger?.log?.(
                `Startup: Skip create ${plan.orderLabel} (STARTUP-CROSS-GUARD) - price ` +
                `${Format.formatPrice6(createPrice)} crosses live ${crossed.type} ` +
                `${crossed.id || crossed.chainOrderId || 'chain'} (${crossed.orderId || crossed.chainOrderId}) ` +
                `@${Format.formatPrice6(crossed.price)}`,
                'warn'
            );
            continue;
        }

        const { amountToSell, sellAssetId, minToReceive, receiveAssetId } = buildCreateOrderArgs(
            gridOrder,
            manager.assets.assetA,
            manager.assets.assetB
        );

        const buildResult = await chainOrders.buildCreateOrderOp(
            account,
            amountToSell,
            sellAssetId,
            minToReceive,
            receiveAssetId,
            null
        );

        if (!buildResult) {
            logger?.log?.(`Startup: Skip create ${plan.orderLabel} - order amounts too small to place on-chain`, 'warn');
            continue;
        }

        prepared.push({ plan, op: buildResult.op });
    }

    if (prepared.length === 0) return [];

    const recovery = _resolveGroupRecovery(
        group,
        `Startup: Triggering recovery sync after create group ${groupIndex + 1}/${totalGroups} failure`,
        'startupCreateGroupFailure'
    );

    const createdOrderIds: string[] = [];

    try {
        logger?.log?.(
            `Startup: Broadcasting create group ${groupIndex + 1}/${totalGroups} in single batch (${prepared.length} op${prepared.length > 1 ? 's' : ''})`,
            'info'
        );

        const batchResult = await chainOrders.executeBatch(account, privateKey, prepared.map((p: any) => p.op));
        const opResults = _extractBatchOperationResults(batchResult);
        const btsFeeData = getAssetFees('BTS');

        // Phase A: Extract ALL chain order IDs from batch results first, capturing
        // every on-chain ID before any _applySync call. This ensures createdOrderIds
        // is complete even if a subsequent _applySync throws mid-loop.
        const batchResults: Array<{ chainOrderId: string | null; plan: any }> = [];
        let missingChainOrderId = false;
        for (let i = 0; i < prepared.length; i++) {
            const chainOrderId = opResults[i] && opResults[i][1];
            const plan = prepared[i].plan;
            if (!chainOrderId) {
                logger?.log?.(`Startup: create result missing chainOrderId for ${plan.orderLabel}`, 'error');
                missingChainOrderId = true;
            } else {
                createdOrderIds.push(chainOrderId);
            }
            batchResults.push({ chainOrderId, plan });
        }

        // Phase B: Register each created order with the manager. All IDs are
        // already in createdOrderIds, so _applySync failures won't lose them.
        for (const { chainOrderId, plan } of batchResults) {
            if (!chainOrderId) continue;

            await manager._applySync({
                gridOrderId: plan.gridOrder.id,
                chainOrderId,
                isPartialPlacement: false,
                expectedType: plan.gridOrder.type,
                fee: btsFeeData.createFee
            }, 'createOrder');
        }

        if (missingChainOrderId) {
            // Broadcast landed but some create results were missing their chain
            // ids: those slots are possibly-landed without an adoptable id —
            // mark them as durable orphan evidence for the next load.
            await _markSlotsCreateUncertain(
                manager,
                batchResults.filter((b: any) => !b.chainOrderId).map((b: any) => b.plan?.gridOrder?.id),
                logger
            );
            await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger,
                triggerMessage: recovery.triggerMessage,
                source: recovery.source,
                });
        }
    } catch (err: any) {
        const isUncertain = err?.code === 'BROADCAST_UNCERTAIN' || err?.name === 'BroadcastUncertainError';
        logger?.log?.(
            `Startup: Failed to create group ${groupIndex + 1}/${totalGroups}${isUncertain ? ' (uncertain broadcast)' : ''}: ${getErrorMessage(err)}`,
            'error'
        );
        if (isUncertain) {
            // The batch may have landed despite the deadline. Verify on chain and
            // adopt any landed orders via chain sync instead of blindly
            // re-broadcasting (duplicate order risk).
            logger?.log?.(
                `Startup: Verifying uncertain create group ${groupIndex + 1}/${totalGroups} on chain; adopting any landed orders`,
                'warn'
            );
            try {
                // An empty/truncated verification read is ambiguous, NOT
                // proof that nothing landed: a truncated get_full_accounts
                // window omits the freshest creates (exactly this batch's),
                // and an empty snapshot may be a node lagging behind the
                // just-broadcast transaction. Treating it as "nothing
                // landed" would let a later pass re-create (duplicate) or
                // cancel as surplus the very orders this batch placed.
                // Mirror the single-create sibling: defer through the
                // guarded recovery sync, which re-reads and only syncs on
                // an authoritative snapshot (deferring to the next
                // reconcile cycle otherwise).
                const freshChainOrders = await readOpenOrdersGuarded(
                    chainOrders,
                    resolveAccountRef(manager, account),
                    {
                        log: (message: string, level: any) => logger?.log?.(message, level),
                        label: 'STARTUP',
                        deferEmpty: true,
                        timeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
                        skipMessage: (kind: string) =>
                            `Startup: Uncertain create group ${groupIndex + 1}/${totalGroups} verification read is ` +
                            `${kind}; cannot confirm whether the batch landed - ` +
                            `deferring to guarded recovery sync (duplicate-order protection)`,
                    }
                );
                if (freshChainOrders === null) {
                    // Verification impossible: every group member is a
                    // possibly-landed create. Mark all slots, then let the
                    // guarded recovery sync adopt anything that actually landed.
                    await _markSlotsCreateUncertain(
                        manager,
                        prepared.map((p: any) => p?.plan?.gridOrder?.id),
                        logger
                    );
                    await _recoverStartupSyncFailure({
                        chainOrders,
                        manager,
                        account,
                        logger,
                        triggerMessage: recovery.triggerMessage,
                        source: recovery.source,
                    });
                } else {
                    await manager.syncFromOpenOrders(freshChainOrders, {
                        // Accounting enabled: the batch's created orders were
                        // never registered (no _applySync ran), so the adoption
                        // must lock their capital. skipAccounting:true would
                        // leave the optimistic balances drifted.
                        skipAccounting: false,
                        source: 'startup-create-group-uncertain-adopt',
                    });
                    // Complete the create accounting (fees + order registration)
                    // for every group plan whose slot was adopted, and register
                    // the adopted IDs so the final refresh never cancels them
                    // as surplus.
                    const btsFeeData = getAssetFeesSafe('BTS');
                    for (const item of prepared) {
                        const plan = item?.plan;
                        const slot = plan?.gridOrder?.id ? manager.orders.get(plan.gridOrder.id) : null;
                        if (!slot?.orderId) continue;
                        try {
                            await manager._applySync({
                                gridOrderId: plan.gridOrder.id,
                                chainOrderId: slot.orderId,
                                isPartialPlacement: false,
                                expectedType: plan.gridOrder.type,
                                fee: btsFeeData?.createFee || 0,
                            }, 'createOrder');
                            createdOrderIds.push(slot.orderId);
                            logger?.log?.(
                                `Startup: Uncertain create for ${plan.orderLabel} confirmed on chain (${slot.orderId}); adopted + accounted`,
                                'warn'
                            );
                        } catch (applyErr: any) {
                            logger?.log?.(
                                `Startup: Adoption accounting failed for ${plan.orderLabel}: ${getErrorMessage(applyErr)}`,
                                'warn'
                            );
                        }
                    }
                    // Plans whose slot still has no orderId after the adoption
                    // pass are possibly-landed creates: mark durable orphan
                    // evidence for the next loadGrid sanitizer.
                    await _markSlotsCreateUncertain(
                        manager,
                        prepared
                            .filter((p: any) => !manager.orders.get(p?.plan?.gridOrder?.id)?.orderId)
                            .map((p: any) => p?.plan?.gridOrder?.id),
                        logger
                    );
                }
            } catch (verifyErr: any) {
                logger?.log?.(
                    `Startup: Uncertain group verification failed: ${getErrorMessage(verifyErr)}; falling back to recovery sync`,
                    'error'
                );
                await _markSlotsCreateUncertain(
                    manager,
                    prepared.map((p: any) => p?.plan?.gridOrder?.id),
                    logger
                );
                await _recoverStartupSyncFailure({
                    chainOrders,
                    manager,
                    account,
                    logger,
                    triggerMessage: recovery.triggerMessage,
                    source: recovery.source,
                });
            }
        } else {
            await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger,
                triggerMessage: recovery.triggerMessage,
                source: recovery.source,
            });
        }
    }

    return createdOrderIds;
}

function _buildOutsideInCreateGroups(createPlans: any): any[] {
    return buildOutsideInPairGroups(createPlans, {
        isValid: (p: any) => Boolean(p?.gridOrder),
        getType: (p: any) => p.orderType,
        getPrice: (p: any) => p.gridOrder?.price,
    });
}

async function _executePlannedStartupCreates({
    createPlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    createPlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<Set<string>> {
    const logger = manager?.logger;
    const groups = _buildOutsideInCreateGroups(createPlans);
    const createdOrderIds = new Set<string>();
    if (groups.length === 0) return createdOrderIds;

    logger?.log?.(`Startup: Executing ${createPlans.length} planned create(s) in ${groups.length} outside->center group(s)`, 'info');

    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const labels = group.map((p: any) => `${p.orderType.toUpperCase()}:${p.gridOrder?.id}`).join(', ');
        logger?.log?.(`Startup: Create group ${i + 1}/${groups.length} (${labels})`, 'info');
        const canBatchCreate = typeof chainOrders?.buildCreateOrderOp === 'function' && typeof chainOrders?.executeBatch === 'function';
        if (group.length > 1 && canBatchCreate) {
            const batchIds = await _executeStartupCreateGroupBatch({
                group,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
                groupIndex: i,
                totalGroups: groups.length,
                });
            for (const id of batchIds) createdOrderIds.add(id);
            continue;
        }

        if (group.length > 1 && !canBatchCreate) {
            logger?.log?.('Startup: Batch create helpers unavailable; falling back to sequential creates for this group', 'warn');
        }

        for (const plan of group) {
            const chainOrderId = await _createStartupOrderWithHandling({
                chainOrders,
                account,
                privateKey,
                manager,
                gridOrder: plan.gridOrder,
                orderLabel: plan.orderLabel,
                dryRun,
                recovery: plan.recovery,
                });
            if (chainOrderId) createdOrderIds.add(chainOrderId);
        }
    }

    const failedCount = Math.max(0, createPlans.length - createdOrderIds.size);
    logger?.log?.(
        `Startup: Create execution summary: ${createdOrderIds.size}/${createPlans.length} planned create(s) placed ` +
        `across ${groups.length} group(s)${failedCount > 0 ? `, ${failedCount} failed/skipped (see error logs)` : ''}`,
        failedCount > 0 ? 'warn' : 'info'
    );

    return createdOrderIds;
}

async function _reconcileStartupSide({
    orderType,
    targetCount,
    chainSideOrders,
    unmatchedSideOrders,
    manager,
    chainOrders,
    account,
    privateKey,
    dryRun,
    plannedCreates,
    plannedUpdates,
    plannedCancels,
    planOnly = false,
}: {
    orderType: any;
    targetCount: any;
    chainSideOrders: any;
    unmatchedSideOrders: any;
    manager: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    dryRun: any;
    plannedCreates: any;
    plannedUpdates: any;
    plannedCancels: any[];
    planOnly?: boolean;
}): Promise<{ chainCount: any }> {
    const logger = manager?.logger;
    const sideUpper = orderType === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
    const balanceKey = orderType === ORDER_TYPES.SELL ? 'sellFree' : 'buyFree';
    const balanceSymbol = orderType === ORDER_TYPES.SELL ? manager.assets.assetA.symbol : manager.assets.assetB.symbol;

    const {
        sortUpdateComparator,
        sortExcessCancelComparator,
        sortMatchedCancelComparator,
    } = _getStartupSideComparators(orderType, manager.assets);

    const matchedOnGrid = _countActiveOnGrid(manager, orderType);
    const neededSlots = Math.max(0, targetCount - matchedOnGrid);
    const desiredSlots = _pickVirtualSlotsToActivate(manager, orderType, neededSlots);

    const sortedUnmatched = unmatchedSideOrders.slice(0).sort(sortUpdateComparator);
    const updateCount = Math.min(sortedUnmatched.length, desiredSlots.length);
    let cancelledIndex: number | null = null;
    let projectedSideBalance = Number(manager.accountTotals?.[balanceKey] || 0);

    logger?.log?.(
        `Startup ${sideUpper}: matchedOnGrid=${matchedOnGrid}, needSlots=${neededSlots}, unmatched=${sortedUnmatched.length}, updates=${updateCount}`,
        'info'
    );

    if (updateCount > 0 && _isGridEdgeFullyActive(manager, orderType, updateCount)) {
        logger?.log?.(`Startup: ${sideUpper} grid edge is fully active, cancelling largest order to free funds`, 'info');
        const cancelInfo = await _cancelLargestOrder({
            chainOrders,
            account,
            privateKey,
            manager,
            unmatchedOrders: sortedUnmatched,
            updateCount,
            orderType,
            dryRun,
            planOnly,
        });
        if (cancelInfo) {
            cancelledIndex = cancelInfo.index;
            if (planOnly && cancelInfo.chainOrderObj) {
                plannedCancels.push({
                    chainOrderId: cancelInfo.chainOrderObj.id,
                    chainOrderObj: cancelInfo.chainOrderObj,
                    releaseUntrackedFunds: true,
                });
            }
        }
    }

    for (let i = 0; i < updateCount; i++) {
        if (cancelledIndex !== null && i === cancelledIndex) continue;

        const chainOrder = sortedUnmatched[i];
        const gridOrder = desiredSlots[i];
        const gridSize = Number(gridOrder.size) || 0;
        const parsedChain = parseChainOrder(chainOrder, manager.assets);
        const currentSize = parsedChain ? (parsedChain.size ?? 0) : 0;
        const sizeIncrease = Math.max(0, gridSize - currentSize);
        const currentAssetBalance = projectedSideBalance;

        if (sizeIncrease > currentAssetBalance) {
            logger?.log?.(
                `Startup: Skipping ${sideUpper} update ${chainOrder.id} - insufficient balance for increase (need +${Format.formatSizeByOrderType(sizeIncrease, orderType, manager.assets)} ${balanceSymbol}, have ${Format.formatSizeByOrderType(currentAssetBalance, orderType, manager.assets)} ${balanceSymbol})`,
                'warn'
            );
            continue;
        }

        logger?.log?.(
            `Startup: Updating chain ${sideUpper} ${chainOrder.id} -> grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatSizeByOrderType(gridOrder.size, orderType, manager.assets)})`,
            'info'
        );

        plannedUpdates.push({
            orderType,
            chainOrderId: chainOrder.id,
            chainOrderObj: chainOrder,
            gridOrderId: gridOrder.id,
            gridOrder: { ...gridOrder },
        });

        projectedSideBalance += (currentSize - gridSize);
    }

    if (cancelledIndex !== null && !dryRun) {
        const targetGridOrder = desiredSlots[cancelledIndex];
        if (targetGridOrder) {
            logger?.log?.(
                `Startup: Creating new ${sideUpper} for cancelled slot at grid ${targetGridOrder.id} (price=${Format.formatPrice6(targetGridOrder.price)}, size=${Format.formatSizeByOrderType(targetGridOrder.size, orderType, manager.assets)})`,
                'info'
            );
            plannedCreates.push({
                orderType,
                gridOrder: targetGridOrder,
                orderLabel: `${sideUpper} for cancelled slot`,
                recovery: {
                    triggerMessage: `Startup: Triggering recovery sync after ${sideUpper} creation failure`,
                    source: 'phase3CreationFailure',
                },
            });
        }
    }

    const processedUnmatched = sortedUnmatched.slice(updateCount);
    const chainCount = chainSideOrders.length;
    const createCount = Math.max(0, targetCount - chainCount);
    const remainingSlots = desiredSlots.slice(updateCount);

    for (let i = 0; i < Math.min(createCount, remainingSlots.length); i++) {
        const gridOrder = remainingSlots[i];
        logger?.log?.(
            `Startup: Creating ${sideUpper} for grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatSizeByOrderType(gridOrder.size, orderType, manager.assets)})`,
            'info'
        );
        plannedCreates.push({
            orderType,
            gridOrder,
            orderLabel: sideUpper,
            // Intentionally no recovery metadata here.
            // This preserves legacy behavior: regular virtual-slot creates only log failures,
            // while cancelled-slot replacement creates trigger a startup recovery sync.
        });
    }

    // Guard: when the matcher found zero active grid orders (matchedOnGrid === 0)
    // AND we're actively scaling up (neededSlots > 0), the grid is freshly
    // generated — all orders are VIRTUAL and every chain order appears
    // "unmatched" only because no slot has been assigned yet. Cancelling here
    // would remove legitimate live orders. Stale duplicates are caught by
    // the SUSPECTED DUPLICATE detection in Phase 1 of reconcileGridOrders;
    // any remaining unmatched will be handled by the next structural
    // divergence cycle. Better to over-keep than to nuke on a false-positive.
    // When targetCount is 0 or matchedOnGrid > 0 the existing cancel logic
    // applies as before.
    let cancelCount = 0;
    if (matchedOnGrid > 0 || neededSlots === 0) {
        cancelCount = Math.max(0, chainCount - targetCount);
    }
    if (cancelCount > 0) {
        const parsedUnmatched = processedUnmatched
            .map((co: any) => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter((x: any) => x.parsed)
            .sort(sortExcessCancelComparator);

        if (planOnly) {
            // In planOnly mode, record the cancellations for Phase 2 execution.
            // This prevents blockchain I/O inside _gridLock (Level 3).
            if (cancelCount > 0) {
                logger?.log?.(
                    `Startup: ${sideUpper} excess ${cancelCount} order(s) queued for cancellation (Phase 2)`,
                    'info'
                );
                for (const x of parsedUnmatched) {
                    if (cancelCount <= 0) break;
                    plannedCancels.push({
                        chainOrderId: x.chain.id,
                        chainOrderObj: x.chain,
                        releaseUntrackedFunds: true,
                    });
                    cancelCount--;
                }
            }
        } else {
            for (const x of parsedUnmatched) {
                if (cancelCount <= 0) break;
                logger?.log?.(`Startup: Cancelling excess ${sideUpper} chain order ${x.chain.id}`, 'info');
                try {
                    await _cancelChainOrder({
                        chainOrders,
                        account,
                        privateKey,
                        manager,
                        chainOrderId: x.chain.id,
                        chainOrderObj: x.chain,
                        releaseUntrackedFunds: true,
                        dryRun,
                    });
                    logger?.log?.(`Startup: Successfully cancelled excess ${sideUpper} order ${x.chain.id}`, 'info');
                    cancelCount--;
                } catch (err: any) {
                    logger?.log?.(`Startup: Failed to cancel ${sideUpper} ${x.chain.id}: ${getErrorMessage(err)}`, 'error');
                }
            }

            if (cancelCount > 0) {
                const activeOrders = manager.getOrdersByTypeAndState(orderType, ORDER_STATES.ACTIVE)
                    .filter((o: any) => o && o.orderId)
                    .sort(sortMatchedCancelComparator);

                for (const o of activeOrders) {
                    if (cancelCount <= 0) break;
                    logger?.log?.(`Startup: Cancelling excess matched ${sideUpper} ${o.orderId} (grid ${o.id})`, 'warn');
                    try {
                        await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun, chainOrderObj: o });
                        logger?.log?.(`Startup: Successfully cancelled excess matched ${sideUpper} order ${o.orderId} (grid ${o.id})`, 'info');
                        cancelCount--;
                    } catch (err: any) {
                        logger?.log?.(`Startup: Failed to cancel matched ${sideUpper} ${o.orderId}: ${getErrorMessage(err)}`, 'error');
                    }
                }
            }
        }
    }



    return {
        chainCount,
    };
}

export { _countActiveOnGrid, _pickVirtualSlotsToActivate, _createOrderFromGrid, _prepareStartupUpdatePlan, _markSlotsCreateUncertain, _cancelChainOrder, _recoverStartupSyncFailure, _refreshStartupUpdatePlans, _executeStartupUpdateBatch, _executeStartupSequentialUpdateFallback, _executeStartupCreateGroupBatch, _createStartupOrderWithHandling, _executePlannedStartupCreates, _reconcileStartupSide }

