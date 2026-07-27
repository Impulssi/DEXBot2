'use strict';

/**
 * modules/order/logger_state.ts - Logger State Manager
 *
 * State tracking engine for change detection and audit logging.
 * Exports a single LoggerState class that enables smart logging by detecting state changes.
 *
 * Purpose:
 * - Track previous state across multiple categories (funds, orders, fills, boundary, errors)
 * - Detect and report what changed between state transitions
 * - Determine if logging is needed (only log when values change)
 * - Maintain audit history of state changes
 * - Calculate significance of numeric changes against thresholds
 *
 * Used by Logger to:
 * - Skip redundant logging when nothing changed
 * - Only output on significant state transitions
 * - Maintain audit trail for debugging
 *
 * ===============================================================================
 * TABLE OF CONTENTS - LoggerState Class (7 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor() - Create new LoggerState with empty previousState and changeHistory
 *      Initializes tracking for: funds, orders, fills, boundary, errors
 *
 * CHANGE DETECTION (2 methods)
 *   2. detectChanges(category, current) - Detect changes between previous and current state
 *      Returns { isNew: boolean, changes: Object } with detailed change information
 *   3. isSignificantChange(oldVal, newVal, threshold) - Check if numeric change exceeds threshold
 *      Returns true if change is significant or values are non-finite
 *
 * HISTORY MANAGEMENT (3 methods)
 *   4. recordChange(timestamp, category, type, data) - Record change for audit trail
 *      Maintains circular buffer (max 100 entries) of all state changes
 *   5. getRecentChanges(category, count) - Get recent changes for a category
 *      Returns last N changes for specified category (default: 10)
 *   6. reset(category) - Clear state for category (reset previous state)
 *
 * INTERNAL UTILITIES (1 method)
 *   7. _deepDiff(prev, current) - Deep diff between two objects
 *      Recursively compares objects, detects all changes and deletions
 *      Returns Object with format: { key: { from: oldVal, to: newVal } }
 *
 * ===============================================================================
 *
 * STATE CATEGORIES:
 * - funds: Available, committed, total, cache, and fee tracking
 * - orders: Order counts, states, and type distributions
 * - fills: Fill operations and trade history
 * - boundary: Grid boundary positions and movements
 * - errors: Error conditions and recovery attempts
 *
 * CHANGE DETECTION ALGORITHM:
 * 1. First call: Returns { isNew: true, changes: current } and stores state
 * 2. Subsequent calls: Compares with stored state using _deepDiff
 * 3. _deepDiff: Recursively compares all keys, detects additions/deletions
 * 4. Returns: { isNew: false, changes: { key: { from, to } } }
 *
 * CHANGE HISTORY:
 * - Stores up to 100 recent changes (FIFO circular buffer)
 * - Each entry: { timestamp, category, type, data }
 * - Enables audit trails and debugging of state transitions
 *
 * ===============================================================================
 *
 * @class
 */

class LoggerState {
    previousState: Record<string, any>;
    changeHistory: Array<{ timestamp: number; category: string; type: string; data: any }>;
    maxHistory: number;

    constructor() {
        this.previousState = {
            funds: null,
            orders: null,
            fills: null,
            boundary: null,
            errors: null
        };
        this.changeHistory = [];
        this.maxHistory = 100;
    }

    /**
     * Detect what changed between previous and current state
     * @param {string} category - Category name (funds, orders, fills, etc.)
     * @param {Object} current - Current state object
     * @returns {Object} { isNew: boolean, changes: Object }
     */
    detectChanges(category: any, current: any) {
        const prev = this.previousState[category];
        if (!prev) {
            this.previousState[category] = { ...current };
            return { isNew: true, changes: current };
        }

        const changes = this._deepDiff(prev, current);
        this.previousState[category] = { ...current };
        return { isNew: false, changes };
    }

    /**
     * Check if change exceeds significance threshold
     * @param {number} oldVal - Previous value
     * @param {number} newVal - Current value
     * @param {number} threshold - Threshold for significance
     * @returns {boolean} True if change is significant
     */
    isSignificantChange(oldVal: any, newVal: any, threshold: any = 0) {
        if (!Number.isFinite(oldVal) || !Number.isFinite(newVal)) return true;
        return Math.abs(oldVal - newVal) > threshold;
    }

    /**
     * Record change for history (auditing)
     * @param {number} timestamp - Unix timestamp
     * @param {string} category - Log category
     * @param {string} type - Event type
     * @param {Object} data - Change data
     */
    recordChange(timestamp: any, category: any, type: any, data: any) {
        this.changeHistory.push({ timestamp, category, type, data });
        if (this.changeHistory.length > this.maxHistory) {
            this.changeHistory.shift();
        }
    }

    /**
     * Get recent changes for a category
     * @param {string} category - Category to query
     * @param {number} count - Number of recent changes to return
     * @returns {Array} Recent changes
     */
    getRecentChanges(category: any, count: any = 10) {
        return this.changeHistory
            .filter((c: any) => c.category === category)
            .slice(-count);
    }

    /**
     * Clear state for a category (reset previous state)
     * @param {string} category - Category to reset
     */
    reset(category: any) {
        this.previousState[category] = null;
    }

    /**
     * Deep diff between two objects
     * Detects all changes recursively
     * @param {Object} prev - Previous state
     * @param {Object} current - Current state
     * @returns {Object} Object with keys that changed
     * @private
     */
    _deepDiff(prev: any, current: any) {
        const diff: Record<string, any> = {};

        // Check all keys in current
        for (const key in current) {
            if (JSON.stringify(prev[key]) !== JSON.stringify(current[key])) {
                diff[key] = { from: prev[key], to: current[key] };
            }
        }

        // Check for deleted keys
        for (const key in prev) {
            if (!(key in current)) {
                diff[key] = { from: prev[key], to: undefined };
            }
        }

        return diff;
    }
}

export default LoggerState

module.exports = LoggerState
