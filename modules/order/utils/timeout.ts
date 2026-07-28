/**
 * modules/order/utils/timeout.ts - Promise timeout utility
 *
 * Leaf module: zero imports from the order system, safe to import from
 * anywhere without creating circular dependencies.
 */

/** Private sentinel — thrown inside the timeout promise to signal resolve-mode timeout. */
const TIMEOUT_RESOLVE_SENTINEL = Symbol('withTimeout.resolve');

/**
 * Race a promise against a timeout, always cleaning up the timer.
 *
 * When `onTimeout` is `'resolve'`, the original promise may keep running after
 * this function returns. Callers should swallow late rejections (e.g.
 * `promise.catch(() => {})`) if the promise could reject after timeout.
 */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    options: { onTimeout: 'resolve'; defaultValue: T; label?: string; onTimeoutCallback?: () => void }
): Promise<T>;
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    options?: { onTimeout?: 'reject'; label?: string; onTimeoutCallback?: () => void }
): Promise<T>;
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    options?: {
        onTimeout?: 'reject' | 'resolve';
        defaultValue?: T;
        label?: string;
        onTimeoutCallback?: () => void;
    }
): Promise<T> {
    const onTimeout = options?.onTimeout ?? 'reject';
    const label = options?.label;
    const onTimeoutCallback = options?.onTimeoutCallback;
    let timerId: any;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timerId = setTimeout(() => {
            try { onTimeoutCallback?.(); } catch (_) { /* non-fatal */ }
            const msg = label
                ? `${label} timed out after ${timeoutMs}ms`
                : `Timed out after ${timeoutMs}ms`;
            reject(onTimeout === 'resolve' ? TIMEOUT_RESOLVE_SENTINEL : new Error(msg));
        }, timeoutMs);
    });
    // In resolve mode, the original promise may reject after timeout. Suppress
    // the unhandled rejection and convert it to resolve(defaultValue) so the
    // race doesn't propagate it. The caller already got defaultValue from the
    // timeout path.
    const racePromise = onTimeout === 'resolve'
        ? Promise.resolve(promise).catch(() => options!.defaultValue as T)
        : promise;
    try {
        return await Promise.race([racePromise, timeoutPromise]);
    } catch (err: any) {
        if (onTimeout === 'resolve' && err === TIMEOUT_RESOLVE_SENTINEL) {
            return options!.defaultValue as T;
        }
        throw err;
    } finally {
        clearTimeout(timerId);
    }
}
