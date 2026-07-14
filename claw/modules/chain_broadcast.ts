const { createAccountClient } = require('./bitshares_client');
const { path } = require('../../modules/path_api');
const { getStorage } = require('../../modules/storage');
const storage = getStorage();
const {
  isCredentialDaemonReady,
  broadcastOperationViaCredentialDaemon,
  executeOperationsViaCredentialDaemon,
  waitForCredentialDaemon
} = require('./dexbot_credential_client');
const { getDexbot2Root, requireDexbot2Module } = require('./dexbot_bridge');
const { Config } = require('../../modules/config');
const { DAEMON_ERRORS } = require('../../modules/constants');
const { getCredentialReadyFilePath } = require('../../modules/credential_runtime');
const { readJSON } = require('../../modules/utils/fs_utils');
const { runtime } = require('../../modules/runtime');

// Lazy-load DEXBot2 modules
let chainKeys: any = null;
let credentialPolicy: any = null;

function getChainKeys() {
  if (!chainKeys) chainKeys = requireDexbot2Module('modules/chain_keys.js');
  return chainKeys;
}

function getCredentialPolicy() {
  if (!credentialPolicy) credentialPolicy = requireDexbot2Module('modules/credential_policy.js');
  return credentialPolicy;
}

function _sendSighupToDaemon() {
  try {
    const root = getDexbot2Root();
    const readyFile = getCredentialReadyFilePath({ root });
    if (storage.exists(readyFile)) {
      const daemonInfo = readJSON(readyFile);
      if (daemonInfo && typeof daemonInfo.pid === 'number') {
        runtime.kill(daemonInfo.pid, 'SIGHUP');
        console.log(`[CLAW][credential-daemon] Sent SIGHUP (pid ${daemonInfo.pid}) to reload policy config`);
      }
    }
  } catch (sigErr: any) {
    console.warn(`[CLAW][credential-daemon] Could not send SIGHUP: ${sigErr.message}`);
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
      const policyPath = path.join(getDexbot2Root(), 'profiles', 'daemon-policies.json');
      botHmacSecret = policyMod.loadBotHmacSecret(accountName, policyPath);
    }
  } catch (err: any) {
    console.warn(`[CLAW] Failed to resolve session credentials: ${err.message}`);
  }

  return { sessionId, botHmacSecret };
}

async function createSigningClient(accountName: any, privateKey: any) {
  return createAccountClient(accountName, privateKey);
}

function resolveAccountName(options: Record<string, any> = {}) {
  return options.accountName || Config.BITSHARES_ACCOUNT || null;
}

async function createSigningClientFromCredentialDaemon(options: Record<string, any> = {}) {
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

  return createSigningClientFromCredentialDaemon({
    ...options,
    accountName
  });
}

function normalizeOperations(operations: any) {
  const ops = Array.isArray(operations) ? operations : [operations];
  return ops.filter(Boolean);
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

    const daemonTimeoutMs = Number.isFinite(Number(options.daemonTimeoutMs))
      ? Number(options.daemonTimeoutMs)
      : undefined;
    const requestTimeoutMs = Number.isFinite(Number(options.daemonRequestTimeoutMs))
      ? Number(options.daemonRequestTimeoutMs)
      : undefined;

    await waitForCredentialDaemon(daemonTimeoutMs, options);

    let { sessionId, botHmacSecret } = await resolveSessionCredentials(accountName, options);

    try {
      const result = await executeOperationsViaCredentialDaemon(accountName, ops, {
        socketPath: options.socketPath,
        timeoutMs: requestTimeoutMs,
        sessionId,
        botHmacSecret,
        requestType: 'broadcast',
        batchId: options.batchId || null
      });

      return {
        ...result,
        operation_results: result.operation_results || [],
        raw: result.raw || null,
        success: true
      };
    } catch (err: any) {
      const msg = String(err.message || err);
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
        const result = await executeOperationsViaCredentialDaemon(accountName, ops, {
          socketPath: options.socketPath,
          timeoutMs: requestTimeoutMs,
          sessionId: retry.sessionId,
          botHmacSecret: retry.botHmacSecret,
          requestType: 'broadcast',
          batchId: options.batchId || null
        });
        return {
          ...result,
          operation_results: result.operation_results || [],
          raw: result.raw || null,
          success: true
        };
      }
      throw err;
    }
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

  const result = await tx.broadcast();
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

    const daemonTimeoutMs = Number.isFinite(Number(options.daemonTimeoutMs))
      ? Number(options.daemonTimeoutMs)
      : undefined;
    const requestTimeoutMs = Number.isFinite(Number(options.daemonRequestTimeoutMs))
      ? Number(options.daemonRequestTimeoutMs)
      : undefined;

    await waitForCredentialDaemon(daemonTimeoutMs, options);

    let { sessionId, botHmacSecret } = await resolveSessionCredentials(accountName, options);

    async function doBroadcast(sid: string | null | undefined, secret: string | null) {
      const result = await broadcastOperationViaCredentialDaemon(accountName, operation, {
        socketPath: options.socketPath,
        timeoutMs: requestTimeoutMs,
        sessionId: sid,
        botHmacSecret: secret
      });
      const operationResults =
        (result && Array.isArray(result.operation_results) && result.operation_results) ||
        (result && result.trx && Array.isArray(result.trx.operation_results) && result.trx.operation_results) ||
        (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results) ||
        [];
      return { success: true, raw: result, operation_results: operationResults };
    }

    try {
      return await doBroadcast(sessionId, botHmacSecret);
    } catch (err: any) {
      const msg = String(err.message || err);
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
        return await doBroadcast(retry.sessionId, retry.botHmacSecret);
      }
      throw err;
    }
  }

  const client = await getSigningClient(options);
  return client.broadcast(operation);
}

export = {
  broadcastOperation,
  createSigningClient,
  createSigningClientFromCredentialDaemon,
  executeOperations,
  getSigningClient,
  resolveAccountName
};
