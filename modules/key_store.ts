'use strict';

import * as chainKeys from './chain_keys';
import * as credentialPolicy from './credential_policy';
import * as credentialRuntime from './credential_runtime';
import {
    executeOperationsViaCredentialDaemon,
    BroadcastUncertainError,
} from './dexbot_credential_client';
import { DAEMON_ERRORS } from './constants';
import { PATHS } from './paths';
import { getStorage } from './storage';
import { runtime } from './runtime';
import { sleep } from './order/utils/system';
import { getErrorMessage } from './utils/errors';

const storage = getStorage();

export interface SigningResult {
    success: boolean;
    raw?: any;
    operation_results?: any[];
}

export interface KeyStore {
    resolveSigningKey(accountName: string, vaultSecret?: any, chainClient?: any): Promise<any>;
    isDaemonSigningKey(key: any): boolean;
    executeOperations(accountName: string, operations: any[], signingKey: any, extraOptions?: Record<string, any>): Promise<SigningResult>;
}

function buildDaemonBroadcastOptions(signingKey: any, extraOptions: Record<string, any>, sessionIdOverride?: string): Record<string, any> {
    return {
        socketPath: signingKey.socketPath,
        sessionId: sessionIdOverride !== undefined ? sessionIdOverride : (signingKey.sessionId || null),
        botHmacSecret: signingKey.botHmacSecret || null,
        requestType: 'broadcast',
        batchId: signingKey.batchId || null,
        ...(extraOptions.nodeUrl ? { nodeUrl: extraOptions.nodeUrl } : {}),
        ...(extraOptions.fallbackNodes ? { fallbackNodes: extraOptions.fallbackNodes } : {}),
        ...(typeof extraOptions.onNodeFailed === 'function' ? { onNodeFailed: extraOptions.onNodeFailed } : {}),
    };
}

function normalizeDaemonResult(result: any): SigningResult {
    return {
        success: true,
        raw: result.raw || null,
        operation_results: Array.isArray(result.operation_results) ? result.operation_results : [],
    };
}

async function broadcastViaChainOrders(accountName: string, operations: any[], signingKey: any): Promise<SigningResult> {
    const { createAccountClient, broadcastTxWithClassification } = require('./chain_orders');
    const acc = await createAccountClient(accountName, signingKey);
    await acc.initPromise;
    const tx = acc.newTx();
    for (const op of operations) {
        const methodName = op.op_name;
        if (typeof tx[methodName] === 'function') {
            tx[methodName](op.op_data);
        } else {
            throw new Error(`Transaction builder does not support ${methodName}`);
        }
    }
    await broadcastTxWithClassification(tx, accountName, operations);
    return { success: true };
}

export class DaemonKeyStore implements KeyStore {
    async resolveSigningKey(accountName: string, vaultSecret?: any, chainClient?: any): Promise<any> {
        if (vaultSecret) {
            return chainKeys.resolvePrivateKey(accountName, vaultSecret, chainClient);
        }

        if (await chainKeys.isDaemonResponsive()) {
            try {
                const sessionId = await chainKeys.probeAccountInDaemon(accountName);
                const botHmacSecret = credentialPolicy.loadBotHmacSecret(
                    accountName,
                    PATHS.PROFILES.DAEMON_POLICIES_JSON,
                    { quiet: true }
                );
                return chainKeys.createDaemonSigningToken(accountName, { sessionId, botHmacSecret });
            } catch {
                const unlockSecret = await chainKeys.authenticate();
                return chainKeys.resolvePrivateKey(accountName, unlockSecret, chainClient);
            }
        }

        const unlockSecret = await chainKeys.authenticate();
        return chainKeys.resolvePrivateKey(accountName, unlockSecret, chainClient);
    }

    isDaemonSigningKey(key: any): boolean {
        return chainKeys.isDaemonSigningToken(key);
    }

    async executeOperations(accountName: string, operations: any[], signingKey: any, extraOptions: Record<string, any> = {}): Promise<SigningResult> {
        if (this.isDaemonSigningKey(signingKey)) {
            try {
                const result = await executeOperationsViaCredentialDaemon(accountName, operations, buildDaemonBroadcastOptions(signingKey, extraOptions));
                return normalizeDaemonResult(result);
            } catch (err: any) {
                if (err instanceof BroadcastUncertainError) throw err;
                if (getErrorMessage(err) && (getErrorMessage(err).includes(DAEMON_ERRORS.SESSION_EXPIRED) || getErrorMessage(err).includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED))) {
                    const isSourceAuthError = getErrorMessage(err).includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED);
                    if (isSourceAuthError) {
                        try {
                            const readyFile = credentialRuntime.getCredentialReadyFilePath({ root: PATHS.PROJECT_ROOT });
                            if (storage.exists(readyFile)) {
                                const daemonInfo = storage.readJSON(readyFile);
                                if (daemonInfo && typeof daemonInfo.pid === 'number') {
                                    runtime.kill(daemonInfo.pid, 'SIGHUP');
                                }
                            }
                        } catch {}
                    }

                    const newSessionId = await chainKeys.probeAccountInDaemon(accountName);
                    signingKey.sessionId = newSessionId;

                    if (isSourceAuthError) {
                        await sleep(500);
                    }

                    const retryResult = await executeOperationsViaCredentialDaemon(accountName, operations, buildDaemonBroadcastOptions(signingKey, extraOptions, signingKey.sessionId));
                    return normalizeDaemonResult(retryResult);
                }
                throw err;
            }
        }

        return broadcastViaChainOrders(accountName, operations, signingKey);
    }
}

export class DirectKeyStore implements KeyStore {
    async resolveSigningKey(accountName: string, vaultSecret?: any, chainClient?: any): Promise<any> {
        if (vaultSecret) {
            return chainKeys.resolvePrivateKey(accountName, vaultSecret, chainClient);
        }
        const unlockSecret = await chainKeys.authenticate();
        return chainKeys.resolvePrivateKey(accountName, unlockSecret, chainClient);
    }

    isDaemonSigningKey(_key: any): boolean { return false; }

    async executeOperations(accountName: string, operations: any[], signingKey: any): Promise<SigningResult> {
        return broadcastViaChainOrders(accountName, operations, signingKey);
    }
}

let _instance: KeyStore | null = null;

export function setKeyStore(impl: KeyStore | null): void {
    _instance = impl;
}

export function resetKeyStore(): void {
    _instance = null;
}

export function getKeyStore(): KeyStore {
    if (!_instance) {
        _instance = new DaemonKeyStore();
    }
    return _instance;
}
