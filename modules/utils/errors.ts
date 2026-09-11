export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
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
