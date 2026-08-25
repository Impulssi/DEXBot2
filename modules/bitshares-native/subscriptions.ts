'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { NATIVE_CLIENT } from '../constants.js';
import Logger from '../order/logger.js';
import { getErrorMessage } from '../utils/errors.js';

const { SUBSCRIPTIONS, OPERATIONS } = NATIVE_CLIENT;

const SUBSCRIBE_CALLBACK_ID = SUBSCRIPTIONS.CALLBACK_ID;
const OP_FILL_ORDER = OPERATIONS.FILL_ORDER;

const subscriptionsLogger = new Logger('Subscriptions');

function createSubscriptionManager(chainClient: any): any {
    const subscriptions = new Map();
    let unsubscribeNotice: any = null;
    const reconnectRetryDelayMs = Number.isFinite(SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS)
        ? Math.max(1000, SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS)
        : SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS;
    const noticeCoalesceMs = Number.isFinite(SUBSCRIPTIONS.NOTICE_COALESCE_MS)
        ? Math.max(0, SUBSCRIPTIONS.NOTICE_COALESCE_MS)
        : 0;
    // Per-subscription pending scan state for coalescing. Keyed by sub object
    // (Map iteration order is stable so we can reuse a single timer per entry).
    const pendingScans = new Map<any, { timer: any; lastNoticeAt: number }>();

    // Fill polling timer + re-entrancy guard for discovering fills via history scan.
    let fillPollTimer: any = null;
    let fillPollInProgress = false;

    function parseObjectIdInstance(id: any): number {
        if (typeof id !== 'string') return Number.NaN;
        const match = id.match(/\.(\d+)$/);
        return match ? Number(match[1]) : Number.NaN;
    }

    function sortEntriesOldestFirst(entries: any[]): any[] {
        return entries.sort((left: any, right: any) => {
            const leftInstance = parseObjectIdInstance(left?.id);
            const rightInstance = parseObjectIdInstance(right?.id);
            if (!Number.isFinite(leftInstance) || !Number.isFinite(rightInstance)) {
                return String(left?.id || '').localeCompare(String(right?.id || ''));
            }
            return leftInstance - rightInstance;
        });
    }

    function decrementObjectId(id: any): string | null {
        if (typeof id !== 'string') return null;
        const match = id.match(/^(.+\.)(\d+)$/);
        if (!match) return null;
        const instance = Number(match[2]);
        if (!Number.isSafeInteger(instance) || instance <= 0) return null;
        return `${match[1]}${instance - 1}`;
    }

    function warnSubscription(sub: any, message: string, err: any = null): void {
        const account = sub?.accountName || sub?.accountId || 'unknown';
        const detail = err?.message ? `: ${getErrorMessage(err)}` : '';
        subscriptionsLogger.warn(`${message} for ${account}${detail}`);
    }

    function getAccountHistoryFetcher(): any {
        return chainClient.history?.getAccountHistory
            || chainClient.history?.get_account_history
            || (chainClient.history?.getAccountHistoryOperations
                ? ((accountId: string, stop: string, limit: number, start: string) => chainClient.history.getAccountHistoryOperations(accountId, OP_FILL_ORDER, start, stop, limit))
                : null)
            || ((...args: any[]) => chainClient.history.call('get_account_history', args));
    }

    async function fetchFullAccountWithRetry(sub: any, subscribe: boolean = false): Promise<any> {
        const accountRef = sub.accountId || sub.accountName;
        let lastErr = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const accounts = await chainClient.db.get_full_accounts([accountRef], subscribe);
                const account = accounts?.[0]?.[1];
                if (account) return account;
                warnSubscription(sub, `get_full_accounts returned no account data on attempt ${attempt}`);
            } catch (err: any) {
                lastErr = err;
                warnSubscription(sub, `get_full_accounts failed on attempt ${attempt}`, err);
            }
        }

        if (lastErr) throw lastErr;
        return null;
    }

    // Use get_account_history (unfiltered) instead of
    // get_account_history_operations (type-filtered). The type-filtered API
    // walks a per-account linked list and may miss fill_order operations even
    // when they exist on chain for the account. The unfiltered API uses the
    // efficient by_op index and returns ALL operation types. We filter for
    // OP_FILL_ORDER client-side in processObjects.
    async function fetchFillHistoryEntries(accountId: string, cursorHistoryId: string, options: any = {}): Promise<any[]> {
        const fetchPage = getAccountHistoryFetcher();

        const entries: any[] = [];
        const seenIds = new Set();
        const cursorInstance = parseObjectIdInstance(cursorHistoryId);
        // Scan history using get_account_history (unfiltered, uses by_op index).
        // Parameters: (accountId, stop, limit, start)
        // API returns entries from start (newest) down to stop (cursor), with
        // start=0 being replaced by the server with the max/head operation ID.
        let startHistoryId = SUBSCRIPTIONS.HISTORY_API_OBJECT;
        let pagesFetched = 0;
        const maxPagesDefault = SUBSCRIPTIONS.HISTORY_MAX_PAGES;
        const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : maxPagesDefault;

        // Cap page size to the node's api_limit_get_account_history to avoid FC_ASSERT.
        const configuredLimit = typeof chainClient.getApiLimitGetAccountHistory === 'function'
            ? chainClient.getApiLimitGetAccountHistory()
            : null;
        const pageLimit = configuredLimit != null
            ? Math.min(SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX, configuredLimit)
            : SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX;
        if (configuredLimit != null && configuredLimit < SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX) {
            subscriptionsLogger.warn(
                `fetchFillHistoryEntries: node api_limit_get_account_history (${configuredLimit}) ` +
                `< HISTORY_LOOKBACK_MAX (${SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX}), capping page size to ${pageLimit}`
            );
        }

        subscriptionsLogger.debug(`fetchFillHistoryEntries: account=${accountId}, cursor=${cursorHistoryId}, start=${startHistoryId}, maxPages=${maxPages}, pageLimit=${pageLimit}`);

        const FETCH_PAGE_TIMEOUT_MS = require('../constants').TIMING.FETCH_HISTORY_PAGE_TIMEOUT_MS;
        const FETCH_TOTAL_DEADLINE_MS = require('../constants').TIMING.FETCH_HISTORY_TOTAL_DEADLINE_MS;
        const scanStartedAt = Date.now();

        while (true) {
            // Outer deadline: if the total scan takes longer than
            // FETCH_HISTORY_TOTAL_DEADLINE_MS, return partial results rather
            // than blocking notice processing indefinitely.
            if (Date.now() - scanStartedAt > FETCH_TOTAL_DEADLINE_MS) {
                subscriptionsLogger.warn(
                    `fetchFillHistoryEntries: total deadline (${FETCH_TOTAL_DEADLINE_MS}ms) exceeded for ${accountId}; ` +
                    `returning ${entries.length} entries across ${pagesFetched} page(s)`
                );
                break;
            }

            let pageTimer: ReturnType<typeof setTimeout> | undefined;
            const page = await Promise.race([
                Promise.resolve(fetchPage(
                    accountId,
                    cursorHistoryId,
                    pageLimit,
                    startHistoryId
                )),
                new Promise<any[]>((_, reject) => {
                    pageTimer = setTimeout(() => {
                        reject(new Error(`fetchFillHistoryEntries: page ${pagesFetched + 1} timed out after ${FETCH_PAGE_TIMEOUT_MS}ms`));
                    }, FETCH_PAGE_TIMEOUT_MS);
                })
            ]).finally(() => {
                if (pageTimer) clearTimeout(pageTimer);
            });
            pagesFetched++;

            const pageLen = Array.isArray(page) ? page.length : 0;
            subscriptionsLogger.debug(`fetchFillHistoryEntries: page ${pagesFetched} returned ${pageLen} entries (start=${startHistoryId}, stop=${cursorHistoryId})`);

            if (!Array.isArray(page) || page.length === 0) break;

            let allEntriesAtOrBeforeCursor = true;
            let skippedCount = 0;
            for (const entry of page) {
                if (!entry || !entry.id || seenIds.has(entry.id)) continue;
                seenIds.add(entry.id);

                // Only keep entries strictly newer than the cursor (already-delivered).
                const entryInstance = parseObjectIdInstance(entry.id);
                if (Number.isFinite(cursorInstance) && Number.isFinite(entryInstance) && entryInstance <= cursorInstance) {
                    skippedCount++;
                    continue;
                }

                allEntriesAtOrBeforeCursor = false;
                entries.push(entry);
            }
            if (skippedCount > 0) {
                subscriptionsLogger.debug(`fetchFillHistoryEntries: skipped ${skippedCount} entries at/before cursor (cursor=${cursorHistoryId})`);
            }

            if (page.length < pageLimit) {
                subscriptionsLogger.debug(`fetchFillHistoryEntries: last page (${page.length} < ${pageLimit})`);
                break;
            }
            if (maxPages !== null && pagesFetched >= maxPages) {
                subscriptionsLogger.debug(`fetchFillHistoryEntries: maxPages (${maxPages}) reached`);
                break;
            }
            // Stop if all entries on this page are at or before the cursor.
            if (allEntriesAtOrBeforeCursor) break;

            const oldestId = page[page.length - 1]?.id;
            const nextStartHistoryId = decrementObjectId(oldestId);
            if (!oldestId || !nextStartHistoryId || nextStartHistoryId === startHistoryId) break;
            startHistoryId = nextStartHistoryId;
        }

        subscriptionsLogger.debug(`fetchFillHistoryEntries: returning ${entries.length} operation(s) across ${pagesFetched} page(s) for ${accountId}`);
        return sortEntriesOldestFirst(entries);
    }

    async function primeLastDeliveredHistoryId(sub: any): Promise<string> {
        if (!sub?.accountId) return SUBSCRIPTIONS.HISTORY_API_OBJECT;

        // Use get_account_history (unfiltered) to find the
        // single most recent history entry. This seeds the cursor past "1.11.0"
        // so fetchFillHistoryEntries can scan from the latest entry forward.
        const fetchAnyPage = getAccountHistoryFetcher();
        try {
            const entries = await Promise.resolve(fetchAnyPage(
                sub.accountId,
                SUBSCRIPTIONS.HISTORY_API_OBJECT,
                1,
                SUBSCRIPTIONS.HISTORY_API_OBJECT
            ));
            const latestId = entries?.[0]?.id;
            if (latestId) {
                subscriptionsLogger.info(`primeLastDeliveredHistoryId: resolved to ${latestId} for ${sub.accountName}`);
                return latestId;
            }
        } catch (err: any) {
            subscriptionsLogger.warn(`primeLastDeliveredHistoryId: get_account_history failed for ${sub.accountName}: ${getErrorMessage(err)}`);
        }

        subscriptionsLogger.info(`primeLastDeliveredHistoryId: no history found, using HISTORY_API_OBJECT for ${sub.accountName}`);
        return SUBSCRIPTIONS.HISTORY_API_OBJECT;
    }

    function ensureNoticeSubscription() {
        if (unsubscribeNotice) {
            if (typeof unsubscribeNotice.isActive !== 'function' || unsubscribeNotice.isActive()) return;
            unsubscribeNotice = null;
        }
        unsubscribeNotice = chainClient.transport.addMessageHandler(handleNotice);
    }

    function removeNoticeSubscription() {
        if (unsubscribeNotice) {
            unsubscribeNotice();
            unsubscribeNotice = null;
        }
    }

    /**
     * Check if a fill object's account_id matches the given account ID.
     * Each fill_order_operation has an `account_id` field identifying
     * the account whose order was filled.
     */
    function fillMatchesAccount(fill: any, accountId: string): boolean {
        const fillAccountId = fill?.op?.[1]?.account_id;
        return fillAccountId === accountId;
    }

    async function handleNotice(params: any): Promise<void> {
        if (!Array.isArray(params) || params.length < 2) {
            subscriptionsLogger.info('handleNotice: skipping (invalid params)');
            return;
        }

        const [callbackId, data] = params;
        if (callbackId !== SUBSCRIBE_CALLBACK_ID) return;

        if (!Array.isArray(data) || data.length === 0) return;

        // Extract fill objects directly from notice data.
        // The BitShares node sends full 1.11.x operation history objects in the
        // notice when a fill occurs. We pass them straight to callbacks — no
        // history scan, no cursor tracking needed for live fills.
        const fillObjects: Array<{ type: string; op: any[]; block_num: any; trx_in_block: any; id: any; }> = [];
        for (const item of data) {
            if (!item || typeof item !== 'object') continue;
            const op = item.op;
            if (Array.isArray(op) && op[0] === OP_FILL_ORDER) {
                fillObjects.push({
                    type: 'fill',
                    op: op,
                    block_num: item.block_num,
                    trx_in_block: item.trx_in_block,
                    id: item.id,
                });
            }
        }

        if (fillObjects.length === 0) {
            // No fills in this notice — scan all active subscriptions to catch
            // up on any fills that may have occurred. Non-fill notices (object
            // changes, statistics updates, etc.) don't carry op data, so we must
            // fall back to history scanning to detect fills.
            //
            // Compute the per-notice max history instance once. Bare object notices
            // (statistics/account/limit-order updates) carry no 1.11.x id, so
            // noticeMaxInstance stays at -1 and the per-subscription cursor check
            // falls through to the coalesced scan path.
            let noticeMaxInstance = -1;
            for (const item of data) {
                if (!item || typeof item !== 'object') continue;
                const id = item.id;
                if (typeof id !== 'string' || !id.startsWith(`${SUBSCRIPTIONS.OPERATION_HISTORY_PREFIX}.`)) continue;
                const inst = parseObjectIdInstance(id);
                if (Number.isFinite(inst) && inst > noticeMaxInstance) {
                    noticeMaxInstance = inst;
                }
            }
            const now = Date.now();
            const eligible: Array<{ active: any; lastDeliveredHistoryId: any; lastNoticeAt: any; accountName: any; accountId: any; _processingHistory: any; callbacks: any; onError: any; }> = [];
            for (const [, sub] of subscriptions) {
                if (!sub.active) continue;
                // Skip when the notice carries a 1.11.x id that this sub's cursor
                // has already covered — no new fills to catch up.
                if (noticeMaxInstance !== -1) {
                    const subCursorInstance = parseObjectIdInstance(sub.lastDeliveredHistoryId);
                    if (Number.isFinite(subCursorInstance) && subCursorInstance >= noticeMaxInstance) continue;
                }
                eligible.push(sub);
            }
            if (eligible.length === 0) return;

            // Coalesce: no-fill notices are just trigger signals. Schedule one
            // history scan per subscription for the coalesce window instead of
            // running one RPC per notice.
            const stampNow = Date.now();
            for (const sub of eligible) {
                // Stamp eligible subs as alive — the notice arrived and a scan
                // will follow. We can't route non-fill objects per-account, so
                // this stamps all eligible subs imprecisely.
                //
                // Coverage gap: if only non-fill notices are arriving (e.g. a
                // statistics-only update for account A), all eligible subs get
                // stamped, masking a per-account fill-stream death for account B.
                // Mitigation: the coalesced processObjects scan (triggered next)
                // fetches fill history per-account via direct RPC, so no fills
                // are actually lost — they're just discovered on the next scan
                // instead of via push notification.
                sub.lastNoticeAt = stampNow;

                // Re-entrancy guard: if _processingHistory is true, a history scan
                // for this subscription is already in flight. Skip this notice — the
                // active scan already walks from the cursor forward and will catch
                // any fills this notice describes. Without this guard, concurrent
                // scans race on lastDeliveredHistoryId advancement, causing
                // double-processing or skipped fills.
                if (sub._processingHistory) continue;
                sub._processingHistory = true;

                const existing = pendingScans.get(sub);
                if (existing) {
                    if ((now - existing.lastNoticeAt) < noticeCoalesceMs) {
                        existing.lastNoticeAt = now;
                        sub._processingHistory = false;
                        continue;
                    }
                    clearTimeout(existing.timer);
                    pendingScans.delete(sub);
                }
                if (noticeCoalesceMs > 0) {
                    const entry = { timer: null as any, lastNoticeAt: now };
                    entry.timer = setTimeout(() => {
                        pendingScans.delete(sub);
                        (processObjects(sub, data).catch((err: any) => {
                            subscriptionsLogger.warn(`processObjects (coalesced) error for ${sub.accountName}: ${getErrorMessage(err)}`);
                        })).finally(() => {
                            sub._processingHistory = false;
                        });
                    }, noticeCoalesceMs);
                    if (typeof entry.timer.unref === 'function') entry.timer.unref();
                    pendingScans.set(sub, entry);
                } else {
                    try {
                        await processObjects(sub, data);
                    } finally {
                        sub._processingHistory = false;
                    }
                }
            }
            return;
        }

        subscriptionsLogger.info(`handleNotice: dispatching ${fillObjects.length} fill(s) directly from notice data`);

        // Batch fills per-subscription and dispatch all at once, so a single
        // callback receives all fills from one notice.
        for (const [, sub] of subscriptions) {
            if (!sub.active) continue;
            const subFills = fillObjects.filter((fill) => fillMatchesAccount(fill, sub.accountId));
            if (subFills.length === 0) continue;

            // Compute cursor for this batch but do NOT advance until callbacks succeed.
            // On failure the cursor stays unchanged so the next processObjects scan
            // (triggered by the next notice or reconnect) will re-fetch these fills.
            // Scan ALL notice entries (not just fills) to prevent re-fetching non-fill
            // operations on subsequent processObjects scans. Non-fill ops may have
            // higher IDs than fills in the same block.
            let latestId: string | null = null;
            let latestInstance = -1;
            for (const item of data) {
                if (!item || typeof item !== 'object') continue;
                const inst = parseObjectIdInstance(item.id);
                if (Number.isFinite(inst) && inst > latestInstance) {
                    latestInstance = inst;
                    latestId = item.id;
                }
            }

            const failed: any[] = [];
            for (const callback of sub.callbacks) {
                try {
                    await Promise.resolve(callback(subFills));
                } catch (err: any) {
                    subscriptionsLogger.warn(`handleNotice: callback error for ${sub.accountName}: ${getErrorMessage(err)}`);
                    failed.push(err);
                }
            }

            // Notice delivered a fill for this account — stamp alive regardless
            // of callback outcome. Callback failure is a processing issue tracked
            // separately (cursor not advanced, onError dispatched).
            sub.lastNoticeAt = Date.now();

            if (failed.length > 0) {
                if (sub.onError) {
                    for (const err of failed) {
                        try { sub.onError(err); } catch (_: any) {}
                    }
                }
                // Cursor NOT advanced — retry on next scan.
            } else if (latestId && (!sub.lastDeliveredHistoryId || parseObjectIdInstance(latestId) > parseObjectIdInstance(sub.lastDeliveredHistoryId))) {
                sub.lastDeliveredHistoryId = latestId;
            }
        }
    }

    async function processObjects(sub: any, data: any, options: any = {}): Promise<void> {
        if (!data || !Array.isArray(data)) return;

        const noticeObjectIds: string[] = [];
        for (const item of data) {
            if (!item) continue;
            const id = typeof item === 'object' ? item.id : item;
            if (typeof id !== 'string') continue;
            noticeObjectIds.push(id);
        }

        if (noticeObjectIds.length === 0) {
            subscriptionsLogger.debug(`processObjects: no identifiable object IDs in notice data for ${sub.accountName} (dataLen=${data?.length}, types=${data.map((d: any) => typeof d).join(',')})`);
            // NOTE: Do NOT return early here. The notice data is just a trigger signal;
            // we must always scan fill history to catch actual fills, because the node
            // may send objects without string `id` fields (e.g. bare account/statistics objects).
            // Fall through to the account fetch + history scan below.
        }

        try {
            // Skip get_full_accounts (heavy RPC) when accountId is already known.
            // All callers (handleNotice, resubscribeEntry, resubscribeAll) either
            // set it during subscribe or refresh it in their preamble.
            let accountId = sub.accountId;
            if (!accountId) {
                const accData = await fetchFullAccountWithRetry(sub, false);
                if (!accData) {
                    subscriptionsLogger.warn(`processObjects: get_full_accounts returned no data for ${sub.accountName}`);
                    if (options.throwOnError) {
                        throw new Error('get_full_accounts returned no account data');
                    }
                    return;
                }
                accountId = accData.account?.id || sub.accountId;
                if (!accountId) {
                    subscriptionsLogger.warn(`processObjects: no account id after fetch for ${sub.accountName}`);
                    if (options.throwOnError) {
                        throw new Error('get_full_accounts returned no account id');
                    }
                    return;
                }
                sub.accountId = accountId;
                sub.statisticsId = accData.account?.statistics || sub.statisticsId || null;
            }

            if (!sub.lastDeliveredHistoryId) {
                sub.lastDeliveredHistoryId = await primeLastDeliveredHistoryId(sub);
                subscriptionsLogger.debug(`processObjects: primed lastDeliveredHistoryId=${sub.lastDeliveredHistoryId} for ${sub.accountName}`);
            }

            const history = await fetchFillHistoryEntries(accountId, sub.lastDeliveredHistoryId, options);
            if (history.length === 0) {
                sub.lastNoticeAt = Date.now();
                subscriptionsLogger.debug(`processObjects: no history entries for ${sub.accountName} (cursor=${sub.lastDeliveredHistoryId})`);
                return;
            }

            const historyRange = history.length > 0
                ? `${history[0]?.id}..${history[history.length - 1]?.id}`
                : 'empty';
            subscriptionsLogger.debug(`processObjects: ${history.length} history entries for ${sub.accountName} range=${historyRange} cursor=${sub.lastDeliveredHistoryId}`);

            const fills: Array<{ type: string; op: any[]; block_num: any; trx_in_block: any; id: any; }> = [];
            for (const entry of history) {
                if (!entry || !entry.op || !entry.id) continue;
                const opData = entry.op;
                if (Array.isArray(opData) && opData[0] === OP_FILL_ORDER) {
                    fills.push({
                        type: 'fill',
                        op: opData,
                        block_num: entry.block_num,
                        trx_in_block: entry.trx_in_block,
                        id: entry.id,
                    });
                }
            }

            if (fills.length > 0) {
                const fillIds = fills.map(f => f.id).join(', ');
                const newCursor = history[history.length - 1]?.id || sub.lastDeliveredHistoryId;
                subscriptionsLogger.info(`processObjects: dispatching ${fills.length} fill(s) to ${sub.callbacks.size} callback(s) for ${sub.accountName} cursor=${newCursor} fills=[${fillIds}]`);
                const failed: any[] = [];
                for (const callback of sub.callbacks) {
                    try {
                        await Promise.resolve(callback(fills));
                    } catch (err: any) {
                        subscriptionsLogger.warn(`processObjects: callback error for ${sub.accountName}: ${getErrorMessage(err)}`);
                        failed.push(err);
                    }
                }

                if (failed.length > 0) {
                    sub.lastNoticeAt = Date.now();
                    if (sub.onError) {
                        for (const err of failed) {
                            try { sub.onError(err); } catch (_: any) {}
                        }
                    }
                    if (options.throwOnError) {
                        // Do NOT advance cursor on throwOnError failure — the caller
                        // (resubscribeEntry/resubscribeAll) will retry and must find
                        // the same fills again.
                        failed[0].subscriptionErrorReported = true;
                        throw failed[0];
                    }
                    // Non-throwing path (e.g. handleNotice fallback scan): also do NOT
                    // advance cursor. The next notice-triggered scan or reconnect will
                    // re-fetch these fills, giving callbacks another chance.
                    return;
                }

                // All callbacks succeeded — advance cursor past this batch.
                sub.lastDeliveredHistoryId = newCursor;
                sub.lastNoticeAt = Date.now();
            } else {
                // No fills in this batch — advance cursor past history to avoid
                // re-scanning non-fill operations on subsequent calls.
                sub.lastDeliveredHistoryId = history[history.length - 1]?.id || sub.lastDeliveredHistoryId;
                sub.lastNoticeAt = Date.now();
                subscriptionsLogger.debug(`processObjects: history had entries but none were FILL_ORDER operations for ${sub.accountName}`);
            }
        } catch (err: any) {
            sub.lastNoticeAt = Date.now();
            subscriptionsLogger.warn(`processObjects: error for ${sub.accountName}: ${getErrorMessage(err)}`);
            if (sub.onError && !err?.subscriptionErrorReported) {
                try { sub.onError(err); } catch (_: any) {}
            }
            if (options.throwOnError) throw err;
        }
    }

    function clearReconnectRetry(entry: any): void {
        if (!entry?.reconnectRetryTimer) return;
        clearTimeout(entry.reconnectRetryTimer);
        entry.reconnectRetryTimer = null;
    }

    function scheduleReconnectRetry(entry: any, err: any): void {
        if (!entry || entry.reconnectRetryTimer || !entry.active || entry.callbacks?.size === 0) return;

        entry.reconnectRetryTimer = setTimeout(() => {
            entry.reconnectRetryTimer = null;
            resubscribeEntry(entry, 'retry').catch((retryErr: any) => {
                subscriptionsLogger.warn(`Failed to resubscribe ${entry.accountName}: ${getErrorMessage(retryErr)}`);
                scheduleReconnectRetry(entry, retryErr);
            });
        }, reconnectRetryDelayMs);
        if (typeof entry.reconnectRetryTimer.unref === 'function') {
            entry.reconnectRetryTimer.unref();
        }

        warnSubscription(entry, `scheduled reconnect retry in ${reconnectRetryDelayMs}ms`, err);
    }

    /**
     * Centralized subscription refresh: set_subscribe_callback then re-subscribe ALL active accounts.
     * cancel_all_subscriptions(false, false) inside set_subscribe_callback clears
     * _subscribed_accounts for every account. Every active entry must be re-subscribed after
     * every call, not just the current one.
     */
    async function refreshSubscriptions(): Promise<any[]> {
        const failures: { entry: any; err: any; }[] = [];
        ensureNoticeSubscription();
        await chainClient.db.call('set_subscribe_callback', [
            SUBSCRIBE_CALLBACK_ID,
            false,
        ]);
        for (const [, subEntry] of subscriptions) {
            if (!subEntry.active) continue;
            try {
                await chainClient.db.get_full_accounts([subEntry.accountName], true);
            } catch (err: any) {
                subscriptionsLogger.warn(`Failed to re-subscribe account after set_subscribe_callback for ${subEntry.accountName}: ${getErrorMessage(err)}`);
                failures.push({ entry: subEntry, err });
            }
        }
        return failures;
    }

    async function resubscribeEntry(entry: any, reason: string = 'reconnect') {
        if (!entry?.active) return;
        if (entry.reconnecting) return;
        entry.reconnecting = true;

        try {
            try {
                const accounts = await chainClient.db.get_full_accounts([entry.accountName], true);
                if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                    entry.accountId = accounts[0][1].account.id;
                    entry.statisticsId = accounts[0][1].account.statistics || null;
                }
            } catch (err: any) {
                subscriptionsLogger.warn(`Failed to refresh account data for ${entry.accountName}: ${getErrorMessage(err)}`);
            }

            const refreshFailures = await refreshSubscriptions();
            const entryRefreshFailure = refreshFailures.find((failure: any) => failure.entry === entry);
            if (entryRefreshFailure) throw entryRefreshFailure.err;
            for (const failure of refreshFailures) {
                scheduleReconnectRetry(failure.entry, failure.err);
            }

            await processObjects(entry, [entry.accountId], {
                throwOnError: true,
            });
            clearReconnectRetry(entry);
            subscriptionsLogger.warn(`Subscription restored for ${entry.accountName} (${reason})`);
        } finally {
            entry.reconnecting = false;
        }
    }

    function startFillPolling(): void {
        if (fillPollTimer) return;

        const intervalMs = Number.isFinite(SUBSCRIPTIONS.FILL_POLL_INTERVAL_MS)
            ? Math.max(10000, SUBSCRIPTIONS.FILL_POLL_INTERVAL_MS)
            : SUBSCRIPTIONS.FILL_POLL_INTERVAL_MS;

        fillPollTimer = setInterval(async () => {
            if (fillPollInProgress) return;
            fillPollInProgress = true;
            try {
                for (const [, entry] of subscriptions) {
                    if (!entry.active) continue;
                    if (entry.reconnecting) continue;
                    try {
                        await processObjects(entry, [entry.accountId]);
                    } catch (err: any) {
                        subscriptionsLogger.warn(`Fill poll failed for ${entry.accountName}: ${getErrorMessage(err)}`);
                    }
                }
            } finally {
                fillPollInProgress = false;
            }
        }, intervalMs);

        if (typeof fillPollTimer.unref === 'function') {
            fillPollTimer.unref();
        }
    }

    function stopFillPolling(): void {
        if (fillPollTimer) {
            clearInterval(fillPollTimer);
            fillPollTimer = null;
        }
    }

    async function subscribe(accountName: string, callback: any, onError: any = null): Promise<any> {
        if (!accountName || typeof accountName !== 'string') {
            throw new Error('accountName is required');
        }
        if (typeof callback !== 'function') {
            throw new Error('callback function is required');
        }

        let entry = subscriptions.get(accountName);
        const createdEntry = !entry;
        if (!entry) {
            entry = {
                accountName,
                accountId: null,
                statisticsId: null,
                lastDeliveredHistoryId: SUBSCRIPTIONS.HISTORY_API_OBJECT,
                lastNoticeAt: Date.now(),
                active: false,
                callbacks: new Set(),
                onError: null,
                reconnectRetryTimer: null,
                reconnecting: false,
            };
            subscriptions.set(accountName, entry);

            // Add callback BEFORE first await so a rollback unsubscribe()
            // during the async work can properly find and remove it,
            // keeping callbacks consistent and avoiding orphaned entries.
            entry.callbacks.add(callback);
            if (onError) entry.onError = onError;

            const accounts = await chainClient.db.get_full_accounts([accountName], true);
            // Detect a rollback unsubscribe() that fired during the await:
            // the entry is gone from the Map, so the native subscription was
            // already torn down by the caller. Abort cleanly without
            // re-priming or registering a server-side subscription — otherwise
            // the local entry would be orphaned (still in memory, not in Map)
            // and handleNotice() would never reach its callbacks.
            if (!subscriptions.has(accountName)) {
                return () => {};
            }
            if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                entry.accountId = accounts[0][1].account.id;
                entry.statisticsId = accounts[0][1].account.statistics || null;
            }
            if (!entry.accountId) {
                subscriptions.delete(accountName);
                throw new Error(`Could not resolve subscribed account: ${accountName}`);
            }
        } else {
            entry.callbacks.add(callback);
            if (onError) entry.onError = onError;
        }

        if (createdEntry) {
            try {
                // Prime the cursor BEFORE remote activation. The cursor is
                // decremented so that the next scan re-fetches the primed fill,
                // ensuring no fills are lost between prime and subscribe.
                const latestFillId = await primeLastDeliveredHistoryId(entry);
                if (!subscriptions.has(accountName)) {
                    // Rollback during prime — entry is gone. Abort without
                    // activating or calling refreshSubscriptions.
                    return () => {};
                }
                entry.lastDeliveredHistoryId = latestFillId
                    ? (decrementObjectId(latestFillId) || latestFillId)
                    : SUBSCRIPTIONS.HISTORY_API_OBJECT;

                entry.active = !!entry.accountId;

                const refreshFailures = await refreshSubscriptions();
                if (!subscriptions.has(accountName)) {
                    // Rollback during refreshSubscriptions — entry is gone.
                    // Abort. The server-side set_subscribe_callback was already
                    // called (side effect of refreshSubscriptions), but the
                    // local entry is no longer in the Map so handleNotice()
                    // cannot dispatch to its callbacks. The orphaned callbacks
                    // become unreachable and will be GC'd on process exit.
                    return () => {};
                }
                const entryRefreshFailure = refreshFailures.find((failure: any) => failure.entry === entry);
                if (entryRefreshFailure) throw entryRefreshFailure.err;
                startFillPolling();
                for (const failure of refreshFailures) {
                    scheduleReconnectRetry(failure.entry, failure.err);
                }

                // NOTE: No initial catch-up scan here.
                // The startup sync (synchronizeWithChain) handles all fills from downtime.
                // processObjects is called on reconnect (resubscribeEntry/resubscribeAll)
                // to catch fills missed during disconnect, at which point the grid is loaded.
            } catch (err: any) {
                // Only clean up if WE still own the entry. If a rollback already
                // deleted it from the Map during the await that threw, the
                // unsubscribe() rollback path is responsible for state — touching
                // it here would corrupt the next subscribe's accounting.
                if (subscriptions.has(accountName)) {
                    entry.callbacks.delete(callback);
                    if (entry.onError === onError) {
                        entry.onError = null;
                    }
                    if (entry.callbacks.size === 0) {
                        entry.active = false;
                        subscriptions.delete(accountName);
                        if (subscriptions.size === 0) {
                            stopFillPolling();
                            removeNoticeSubscription();
                        }
                    }
                }
                throw new Error(`Failed to register subscription callback: ${getErrorMessage(err)}`);
            }
        }

        return () => unsubscribe(accountName, callback);
    }

    async function unsubscribe(accountName: string, callback?: any): Promise<void> {
        const entry = subscriptions.get(accountName);
        if (!entry) return;

        if (callback) {
            entry.callbacks.delete(callback);
        } else {
            entry.callbacks.clear();
        }

        if (entry.callbacks.size === 0) {
            entry.active = false;
            clearReconnectRetry(entry);
            const pending = pendingScans.get(entry);
            if (pending) {
                if (pending.timer) clearTimeout(pending.timer);
                pendingScans.delete(entry);
            }
            subscriptions.delete(accountName);

            if (subscriptions.size === 0) {
                stopFillPolling();
                removeNoticeSubscription();
            }
        }
    }

    async function resubscribeAll() {
        // Drop any coalesced scans scheduled before the reconnect. They reference
        // a pre-reconnect cursor and would race with the catch-up scan below.
        for (const [, pending] of pendingScans) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        pendingScans.clear();

        // Refresh account data for every active entry first (before any RPC calls
        // that might race with each other on the same connection).
        const refreshTasks: Promise<void>[] = [];
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;
            refreshTasks.push(
                chainClient.db.get_full_accounts([entry.accountName], true).then((accounts: any) => {
                    if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                        entry.accountId = accounts[0][1].account.id;
                        entry.statisticsId = accounts[0][1].account.statistics || null;
                    }
                }).catch((err: any) => {
                    subscriptionsLogger.warn(`Failed to refresh account data for ${entry.accountName}: ${getErrorMessage(err)}`);
                })
            );
        }
        await Promise.all(refreshTasks);

        // Centralized subscription setup — one set_subscribe_callback + re-subscribe all.
        const refreshFailures = await refreshSubscriptions();
        const refreshFailureEntries = new Set(refreshFailures.map((failure: any) => failure.entry));
        for (const failure of refreshFailures) {
            scheduleReconnectRetry(failure.entry, failure.err);
        }

        // Catch-up scan for each entry (parallelized for multi-account setups).
        const scanTasks: Promise<void>[] = [];
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;
            if (refreshFailureEntries.has(entry)) continue;
            scanTasks.push(
                processObjects(entry, [entry.accountId], { throwOnError: true })
                    .then(() => clearReconnectRetry(entry))
                    .catch((err: any) => {
                        subscriptionsLogger.warn(`Failed to resubscribe ${entry.accountName}: ${getErrorMessage(err)}`);
                        scheduleReconnectRetry(entry, err);
                    })
            );
        }
        await Promise.all(scanTasks);
    }

    async function onReconnect() {
        await resubscribeAll();
    }

    return {
        subscribe,
        unsubscribe,
        onReconnect,
        resubscribeAll,
        removeNoticeSubscription,
        getSubscriptions: () => new Map(subscriptions),
    };
}

export { createSubscriptionManager }

