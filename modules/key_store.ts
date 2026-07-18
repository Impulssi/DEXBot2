'use strict';

const chainKeys = require('./chain_keys');
const credentialPolicy = require('./credential_policy');
const credentialRuntime = require('./credential_runtime');
const {
    executeOperationsViaCredentialDaemon,
    BroadcastUncertainError,
} = require('./dexbot_credential_client');
const { TIMING, DAEMON_ERRORS } = require('./constants');
const { path } = require('./path_api');
const { PATHS } = require('./paths');
const { getStorage } = require('./storage');
const storage = getStorage();
const { runtime } = require('./runtime');
const { sleep } = require('./order/utils/system');

export interface SigningResult {
    success: boolean;
    raw?: any;
    operation_results?: any[];
}

export interface KeyStore {
    authenticate(): Promise<any>;
    unlockWithPassword(password: string, accountsData?: any): any;
    isMasterPasswordFailure(err: any): boolean;
    readonly MasterPasswordError: any;

    getPrivateKey(accountName: string, vaultSecret: any): string;
    resolvePrivateKey(accountName: string, vaultSecret: any, chainClient: any): Promise<string>;

    isReady(): boolean;
    isResponsive(): Promise<boolean>;
    waitForReady(timeoutMs?: number): Promise<void>;

    resolveSigningKey(accountName: string, vaultSecret?: any, chainClient?: any): Promise<any>;
    isDaemonSigningKey(key: any): boolean;
    executeOperations(accountName: string, operations: any[], signingKey: any, extraOptions?: Record<string, any>): Promise<SigningResult>;

    loadAccounts(): any;
    saveAccounts(data: any): void;
    checkSecurity(): void;
}

export class DaemonKeyStore implements KeyStore {
    get MasterPasswordError(): any { return chainKeys.MasterPasswordError; }

    authenticate(): Promise<any> {
        return chainKeys.authenticate();
    }

    unlockWithPassword(password: string, accountsData?: any): any {
        return chainKeys.unlockWithPassword(password, accountsData);
    }

    isMasterPasswordFailure(err: any): boolean {
        return chainKeys.isMasterPasswordFailure(err);
    }

    getPrivateKey(accountName: string, vaultSecret: any): string {
        return chainKeys.getPrivateKey(accountName, vaultSecret);
    }

    resolvePrivateKey(accountName: string, vaultSecret: any, chainClient: any): Promise<string> {
        return chainKeys.resolvePrivateKey(accountName, vaultSecret, chainClient);
    }

    isReady(): boolean {
        return chainKeys.isDaemonReady();
    }

    isResponsive(): Promise<boolean> {
        return chainKeys.isDaemonResponsive();
    }

    waitForReady(timeoutMs: number = TIMING.DAEMON_STARTUP_TIMEOUT_MS): Promise<void> {
        return chainKeys.waitForDaemon(timeoutMs);
    }

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
                const result = await executeOperationsViaCredentialDaemon(accountName, operations, {
                    socketPath: signingKey.socketPath,
                    sessionId: signingKey.sessionId || null,
                    botHmacSecret: signingKey.botHmacSecret || null,
                    requestType: 'broadcast',
                    batchId: signingKey.batchId || null,
                    ...(extraOptions.nodeUrl ? { nodeUrl: extraOptions.nodeUrl } : {}),
                    ...(extraOptions.fallbackNodes ? { fallbackNodes: extraOptions.fallbackNodes } : {}),
                });
                return {
                    success: true,
                    raw: result.raw || null,
                    operation_results: Array.isArray(result.operation_results) ? result.operation_results : [],
                };
            } catch (err: any) {
                if (err instanceof BroadcastUncertainError) throw err;
                if (err.message && (err.message.includes(DAEMON_ERRORS.SESSION_EXPIRED) || err.message.includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED))) {
                    const isSourceAuthError = err.message.includes(DAEMON_ERRORS.SOURCE_AUTH_DENIED);
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

                    const retryResult = await executeOperationsViaCredentialDaemon(accountName, operations, {
                        socketPath: signingKey.socketPath,
                        sessionId: signingKey.sessionId,
                        botHmacSecret: signingKey.botHmacSecret || null,
                        requestType: 'broadcast',
                        batchId: signingKey.batchId || null,
                        ...(extraOptions.fallbackNodes ? { fallbackNodes: extraOptions.fallbackNodes } : {}),
                    });
                    return {
                        success: true,
                        raw: retryResult.raw || null,
                        operation_results: Array.isArray(retryResult.operation_results) ? retryResult.operation_results : [],
                    };
                }
                throw err;
            }
        }

        const { createAccountClient } = require('./chain_orders');
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
        await tx.broadcast();
        return { success: true };
    }

    loadAccounts(): any {
        return chainKeys.loadAccounts();
    }

    saveAccounts(data: any): void {
        chainKeys.saveAccounts(data);
    }

    checkSecurity(): void {
        chainKeys.checkKeysFileSecurity();
    }
}

export class DirectKeyStore implements KeyStore {
    get MasterPasswordError(): any { return chainKeys.MasterPasswordError; }

    authenticate(): Promise<any> {
        return chainKeys.authenticate();
    }

    unlockWithPassword(password: string, accountsData?: any): any {
        return chainKeys.unlockWithPassword(password, accountsData);
    }

    isMasterPasswordFailure(err: any): boolean {
        return chainKeys.isMasterPasswordFailure(err);
    }

    getPrivateKey(accountName: string, vaultSecret: any): string {
        return chainKeys.getPrivateKey(accountName, vaultSecret);
    }

    resolvePrivateKey(accountName: string, vaultSecret: any, chainClient: any): Promise<string> {
        return chainKeys.resolvePrivateKey(accountName, vaultSecret, chainClient);
    }

    isReady(): boolean { return true; }

    async isResponsive(): Promise<boolean> { return true; }

    async waitForReady(_timeoutMs?: number): Promise<void> {}

    async resolveSigningKey(accountName: string, vaultSecret?: any, chainClient?: any): Promise<any> {
        if (vaultSecret) {
            return chainKeys.resolvePrivateKey(accountName, vaultSecret, chainClient);
        }
        const unlockSecret = await chainKeys.authenticate();
        return chainKeys.resolvePrivateKey(accountName, unlockSecret, chainClient);
    }

    isDaemonSigningKey(_key: any): boolean { return false; }

    async executeOperations(accountName: string, operations: any[], signingKey: any): Promise<SigningResult> {
        const { createAccountClient } = require('./chain_orders');
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
        await tx.broadcast();
        return { success: true };
    }

    loadAccounts(): any {
        return chainKeys.loadAccounts();
    }

    saveAccounts(data: any): void {
        chainKeys.saveAccounts(data);
    }

    checkSecurity(): void {
        chainKeys.checkKeysFileSecurity();
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
