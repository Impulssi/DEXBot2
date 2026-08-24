
import * as client from './bitshares_client.js';
const { createAccountClient } = client;
import { getStorage } from '../../modules/storage/index.js';
import { requireDexbot2Module } from './dexbot_bridge.js';
import { Config } from '../../modules/config.js';
import { PATHS } from '../../modules/paths.js';
import { DAEMON_ERRORS } from '../../modules/constants.js';
import { getCredentialReadyFilePath } from '../../modules/credential_runtime.js';
import { runtime } from '../../modules/runtime.js';
const storage = getStorage();
const { readJSON } = storage;
import { isCredentialDaemonReady, DEFAULT_BROADCAST_TIMEOUT_MS, broadcastOperationViaCredentialDaemon, executeOperationsViaCredentialDaemon, waitForCredentialDaemon, BroadcastUncertainError } from './dexbot_credential_client.js';
import { getErrorMessage } from '../../modules/utils/errors.js';

// Lazy-load DEXBot2 modules
let chainKeys: any = null;
let credentialPolicy: any = null;
let broadcastFailureClassifier: any = null;

function getChainKeys() {
  if (!chainKeys) chainKeys = requireDexbot2Module('modules/chain_keys.js');
  return chainKeys;
}

function getCredentialPolicy() {
  if (!credentialPolicy) credentialPolicy = requireDexbot2Module('modules/credential_policy.js');
  return credentialPolicy;
}

function getBroadcastFailureClassifier() {
  if (!broadcastFailureClassifier) {
    const mod = requireDexbot2Module('modules/broadcast_failure.js');
    broadcastFailureClassifier = (mod && typeof mod.classifyBroadcastFailure === 'function')
      ? mod.classifyBroadcastFailure
      : (mod && typeof mod.default === 'function' ? mod.default : null);
  }
  return broadcastFailureClassifier;
}

/**
 * Classify a direct-key broadcast failure so callers never blindly re-issue
 * an operation whose broadcast may have landed. Mirrors the credential-daemon
 * classification: 'uncertain' becomes a typed BroadcastUncertainError (the
 * same type the daemon path produces), 'retryable'/'definite' propagate as-is.
 * @param {Error} err - The raw broadcast error
 * @param {Array} ops - The operations that were broadcast
 * @param {string|null} accountName - Account the broadcast was for
 * @param {Object} options - Broadcast options (batchId etc.)
 * @returns {Error} The classified error to throw
 */
function classifyClawBroadcastError(err: any, ops: any[], accountName: string | null, options: Record<string, any> = {}) {
  try {
    const classifier = getBroadcastFailureClassifier();
    if (classifier && classifier(err) === 'uncertain') {
      return new BroadcastUncertainError(
        `Claw direct-key broadcast uncertain (may have landed): ${getErrorMessage(err)}`,
        {
          operations: ops,
          accountName,
          batchId: options.batchId || null,
          payload: null,
          timeoutMs: null,
        }
      );
    }
  } catch (_) {
    // Classification is best-effort — fall through to the original error.
  }
  return err;
}

function _sendSighupToDaemon() {
  try {
    const readyFile = getCredentialReadyFilePath();
    if (storage.exists(readyFile)) {
      const daemonInfo = readJSON(readyFile);
      if (daemonInfo && typeof daemonInfo.pid === 'number') {
        runtime.kill(daemonInfo.pid, 'SIGHUP');
        console.log(`[CLAW][credential-daemon] Sent SIGHUP (pid ${daemonInfo.pid}) to reload policy config`);
      }
    }
  } catch (sigErr: any) {
    console.warn(`[CLAW][credential-daemon] Could not send SIGHUP: ${getErrorMessage(sigErr)}`);
  }
}

/**
 * Resolve sessionId and botHmacSecret for an account.
 * Probes the daemon for a session and loads the HMAC secret from DEXBot2 profiles.
 *
 * @param {string} accountName – BitShares account name
 * @param {Object} [options]   – Optional sessionId or botHmacSecret overrides
 * @returns {Promise<{sessionId: string|null, botHmacSecret: string|null}>}
 */
async function resolveSessionCredentials(accountName: any, options: Record<string, any> = {}) {
  let sessionId = options.sessionId || null;
  let botHmacSecret = options.botHmacSecret || null;

  if (sessionId && botHmacSecret) {
    return { sessionId, botHmacSecret };
  }

  try {
    const chainKeysMod = getChainKeys();
    const policyMod = getCredentialPolicy();

    // If no sessionId, probe the daemon
    if (!sessionId) {
      sessionId = await chainKeysMod.probeAccountInDaemon(accountName, 5000, options);
    }

    // If no secret, try to load it from DEXBot2 profile
    if (!botHmacSecret) {
      const policyPath = PATHS.PROFILES.DAEMON_POLICIES_JSON;
      botHmacSecret = policyMod.loadBotHmacSecret(accountName, policyPath);
    }
  } catch (err: any) {
    console.warn(`[CLAW] Failed to resolve session credentials: ${getErrorMessage(err)}`);
  }

  return { sessionId, botHmacSecret };
}

async function createSigningClient(accountName: any, privateKey: any) {
  return createAccountClient(accountName, privateKey);
}

function resolveAccountName(options: Record<string, any> = {}) {
  return options.accountName || Config.BITSHARES_ACCOUNT || null;
}

async function createSigningClientFromCredentialDaemon() {
  throw new Error(
    'The credential daemon no longer exports raw private keys. ' +
    'Use broadcastOperationViaCredentialDaemon() or executeOperationsViaCredentialDaemon() ' +
    'to have the daemon sign and broadcast operations directly.'
  );
}

async function getSigningClient(options: Record<string, any> = {}) {
  const accountName = resolveAccountName(options);
  if (!accountName) {
    throw new Error('accountName is required');
  }

  if (options.privateKey) {
    return createSigningClient(accountName, options.privateKey);
  }

  if (!isCredentialDaemonReady(options)) {
    throw new Error('Credential daemon is not ready');
  }

  return createSigningClientFromCredentialDaemon();
}

function normalizeOperations(operations: any) {
  const ops = Array.isArray(operations) ? operations : [operations];
  return ops.filter(Boolean);
}

/**
 * Shared credential-daemon broadcast plumbing: clamps the request timeout so
 * the daemon's inner deadline can fire first, waits for the daemon, resolves
 * session credentials, and retries once on session/HMAC failures (SIGHUP on
 * source-auth denials). `dispatch` performs the actual daemon call and must
 * be idempotent-safe: it is only re-invoked after credentials are re-resolved.
 */
async function viaCredentialDaemon(accountName: string, options: Record<string, any>, dispatch: (creds: { sessionId: string | null; botHmacSecret: string | null }) => Promise<any>) {
  const daemonTimeoutMs = Number.isFinite(Number(options.daemonTimeoutMs))
    ? Number(options.daemonTimeoutMs)
    : undefined;
  // Clamp the broadcast request timeout up to the default outer window: the
  // daemon's inner deadline (25s) must be allowed to fire and reply a typed
  // BROADCAST_DEADLINE before this socket timer. A caller-supplied short
  // timeout would time out mid-broadcast — a false uncertain.
  const requestTimeoutMs = Number.isFinite(Number(options.daemonRequestTimeoutMs))
    ? Math.max(Number(options.daemonRequestTimeoutMs), DEFAULT_BROADCAST_TIMEOUT_MS)
    : undefined;

  await waitForCredentialDaemon(daemonTimeoutMs, options);

  const creds = await resolveSessionCredentials(accountName, options);
  const socketOptions = {
    socketPath: options.socketPath,
    timeoutMs: requestTimeoutMs
  };

  try {
    return await dispatch({ ...socketOptions, ...creds });
  } catch (err: any) {
    const msg = String(getErrorMessage(err) || err);
    if (msg.includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED) || msg.includes(DAEMON_ERRORS.SESSION_EXPIRED)) {
      const isSourceAuthError = msg.includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED);
      console.warn(`[CLAW] Session/HMAC error, re-resolving credentials and retrying: ${msg}`);
      if (isSourceAuthError) {
        _sendSighupToDaemon();
      }
      const retry = await resolveSessionCredentials(accountName, options);
      if (isSourceAuthError) {
        await new Promise(r => setTimeout(r, 500));
      }
      return await dispatch({ ...socketOptions, ...retry });
    }
    throw err;
  }
}

async function executeOperations(operations: any, options: Record<string, any> = {}) {
  const ops = normalizeOperations(operations);
  if (ops.length === 0) {
    return { success: true, operation_results: [], raw: null };
  }

  if (!options.privateKey && isCredentialDaemonReady(options)) {
    const accountName = resolveAccountName(options);
    if (!accountName) {
      throw new Error('accountName is required');
    }

    const result = await viaCredentialDaemon(accountName, options, async (daemonOptions) =>
      executeOperationsViaCredentialDaemon(accountName, ops, {
        ...daemonOptions,
        requestType: 'broadcast',
        batchId: options.batchId || null
      })
    );

    return {
      ...result,
      operation_results: result.operation_results || [],
      raw: result.raw || null,
      success: true
    };
  }

  const client = await getSigningClient(options);
  if (client.initPromise) {
    await client.initPromise;
  }

  if (typeof client.newTx !== 'function') {
    throw new Error('Signing client does not support newTx()');
  }

  const tx = client.newTx();
  for (const op of ops) {
    if (!op.op_name || !op.op_data) {
      throw new Error('Each operation requires op_name and op_data');
    }
    if (typeof tx[op.op_name] !== 'function') {
      throw new Error(`Transaction builder does not support ${op.op_name}`);
    }
    tx[op.op_name](op.op_data);
  }

  // Direct-key broadcasts must be classified: a timeout/drop here surfaces as
  // a plain Error unless wrapped, inviting callers to blindly re-issue the
  // operations (duplicate orders). 'uncertain' maps to BroadcastUncertainError.
  let result: any;
  try {
    result = await tx.broadcast();
  } catch (err: any) {
    throw classifyClawBroadcastError(err, ops, resolveAccountName(options), options);
  }
  const operationResults =
    (result && Array.isArray(result.operation_results) && result.operation_results) ||
    (result && result.trx && Array.isArray(result.trx.operation_results) && result.trx.operation_results) ||
    (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results) ||
    [];

  return {
    success: true,
    raw: result,
    operation_results: operationResults
  };
}

async function broadcastOperation(operation: any, options: Record<string, any> = {}) {
  if (operation && operation.op_name && operation.op_data) {
    return executeOperations([operation], options);
  }

  if (!options.privateKey && isCredentialDaemonReady(options)) {
    const accountName = resolveAccountName(options);
    if (!accountName) {
      throw new Error('accountName is required');
    }

    return viaCredentialDaemon(accountName, options, async (daemonOptions) => {
      const result = await broadcastOperationViaCredentialDaemon(accountName, operation, {
        ...daemonOptions,
        batchId: options.batchId || null
      });
      const operationResults =
        (result && Array.isArray(result.operation_results) && result.operation_results) ||
        (result && result.trx && Array.isArray(result.trx.operation_results) && result.trx.operation_results) ||
        (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results) ||
        [];
      return { success: true, raw: result, operation_results: operationResults };
    });
  }

  const client = await getSigningClient(options);
  try {
    return await client.broadcast(operation);
  } catch (err: any) {
    throw classifyClawBroadcastError(err, [operation], resolveAccountName(options), options);
  }
}

export { broadcastOperation, executeOperations, getSigningClient, resolveAccountName }

