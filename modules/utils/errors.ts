export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Resolve an optional millisecond override (a test seam on a production code
 * path) to a concrete delay.
 *
 * Returns `fallback` when the value is null/undefined, non-numeric, or
 * negative. An explicit `0` is honored — it means "no delay" — which is why
 * this cannot use a truthiness check, and why the null check must come
 * first: `Number(null) === 0` would otherwise silently select 0 instead of
 * the production default.
 *
 * Single home for the `value != null && Number.isFinite(Number(value)) &&
 * value >= 0` idiom shared by the timing seams (COW missing-create poll
 * interval, credit-deal settle delay, deferred-fill retry backoff).
 */
export function resolveSeamMs(value: unknown, fallback: number): number {
  return value != null && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

/**
 * Like {@link resolveSeamMs}, but returns `null` instead of a fallback so the
 * caller can distinguish "seam set" from "use the production default". Use
 * this when the fallback must be resolved separately (e.g. the credit-deal
 * settle delay falls back to a tuned constant with its own `>= 0` clamp).
 */
export function resolveSeamMsOrNull(value: unknown): number | null {
  return value != null && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;
}

/**
 * Promise-based sleep. Shared by the Kibana retry budgets (client-level
 * one-shot retry, per-page retry, per-range retry) so the linear backoff
 * (`delayMs x attempt`) lives in exactly one place.
 */
export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient network/transport failures worth retrying: aborted streams,
 * connection resets, timeouts, broken pipes, DNS blips and bad-gateway
 * statuses from the Kibana proxy. Anything else (400s, auth, malformed
 * queries) must throw immediately — retrying those only burns time.
 *
 * Single home for the predicate previously triplicated across
 * kibana_client.ts / kibana_candles.ts / kibana_feed_source.ts.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return (
    msg.includes('aborted') ||
    msg.includes('connection reset') ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up') ||
    msg.includes('timed out') ||
    msg.includes('EPIPE') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('HTTP 502') ||
    msg.includes('HTTP 503') ||
    msg.includes('HTTP 504')
  );
}
