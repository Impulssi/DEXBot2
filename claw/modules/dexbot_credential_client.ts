
import { DEFAULT_READY_FILE, DEFAULT_SOCKET_PATH, DEFAULT_BROADCAST_TIMEOUT_MS, executeOperationsViaCredentialDaemon, isCredentialDaemonReady, waitForCredentialDaemon, BroadcastUncertainError } from '../../modules/dexbot_credential_client.js';

function getSocketPath(options: Record<string, any> = {}) {
  return options.socketPath || DEFAULT_SOCKET_PATH;
}

/**
 * Broadcast a single operation via the credential daemon.
 *
 * Delegates to the hardened modules client (execute-operations request type):
 * - the outer broadcast timeout defaults to CREDENTIAL_BROADCAST_TIMEOUT_MS
 *   (30s), which covers the daemon's CREDENTIAL_DAEMON_INNER_DEADLINE_MS
 *   (25s) inner broadcast deadline — the previous 5s request timeout fired
 *   while the daemon was still mid-broadcast;
 * - uncertain outcomes (outer socket timeout, BROADCAST_DEADLINE reply) are
 *   re-thrown as typed BroadcastUncertainError instead of a plain Error, so
 *   callers can avoid a blind re-run that would duplicate on-chain orders;
 * - the daemon retries internally only failures that provably never reached
 *   the chain; an uncertain broadcast is never re-signed.
 *
 * The daemon's broadcast-operation handler and the execute-operations handler
 * evaluate identical policy/HMAC contexts for a single-operation array, so
 * this delegation changes no daemon-side semantics.
 */
function broadcastOperationViaCredentialDaemon(accountName: any, operation: any, options: Record<string, any> = {}) {
  if (!accountName) {
    return Promise.reject(new Error('accountName is required to broadcast operations'));
  }
  if (!operation || typeof operation !== 'object') {
    return Promise.reject(new Error('operation must be an object'));
  }

  // A broadcast's outer socket timeout MUST leave room for the daemon's inner
  // deadline (CREDENTIAL_DAEMON_INNER_DEADLINE_MS, 25s) to fire first and
  // reply a typed BROADCAST_DEADLINE. A caller-supplied timeout below that
  // window would time out while the daemon is still mid-broadcast — a false
  // uncertain on every slow broadcast. Clamp up to the default outer window.
  const callerTimeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : undefined;
  const broadcastTimeoutMs = callerTimeoutMs !== undefined
    ? Math.max(callerTimeoutMs, DEFAULT_BROADCAST_TIMEOUT_MS)
    : undefined;

  return executeOperationsViaCredentialDaemon(accountName, [operation], {
    socketPath: getSocketPath(options),
    timeoutMs: broadcastTimeoutMs,
    sessionId: options.sessionId || null,
    botHmacSecret: options.botHmacSecret || null,
    requestType: 'broadcast',
    batchId: options.batchId || null,
    ...(options.nodeUrl ? { nodeUrl: options.nodeUrl } : {}),
  });
}

export { DEFAULT_READY_FILE, DEFAULT_SOCKET_PATH, DEFAULT_BROADCAST_TIMEOUT_MS, broadcastOperationViaCredentialDaemon, executeOperationsViaCredentialDaemon, isCredentialDaemonReady, waitForCredentialDaemon, BroadcastUncertainError }
