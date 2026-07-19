'use strict';

const { createTransactionBuilder } = require('./tx/builder');
const txCache = require('./tx/tx_cache');

const Logger = require('../logger');
const signingClientLogger = new Logger('SigningClient');

function createSigningClient(chainClient: any, accountName: string, privateKey: any): any {
    if (!chainClient) throw new Error('chainClient is required');
    if (!accountName) throw new Error('accountName is required');
    if (!privateKey) throw new Error('privateKey is required');

    let _accountId: any = null;
    let _initResolved = false;
    let _initPromise: any = null;

    _initPromise = (async () => {
        try {
            const full = await chainClient.db.get_full_accounts([accountName], false);
            if (full && full[0]) {
                if (full[0][1] && full[0][1].account && full[0][1].account.id) {
                    _accountId = full[0][1].account.id;
                }
            }
            _initResolved = true;
        } catch (err: any) {
            signingClientLogger.warn(`Failed to resolve account ${accountName}: ${err.message}`);
            _initResolved = true;
        }
    })();

    function newTx() {
        const tx = createTransactionBuilder(chainClient);

        const origSign = tx.sign.bind(tx);
        tx.sign = function() {
            return origSign(Buffer.isBuffer(privateKey)
                ? privateKey
                : wifToBuffer(privateKey));
        };

        return wrapTxForBtsdexCompat(tx, chainClient, privateKey);
    }

    function wifToBuffer(wif: any): any {
        if (typeof wif !== 'string') return wif;
        try {
            const { wifDecode } = require('./crypto/ecc_selector')();
            return wifDecode(wif).privateKey;
        } catch (_: any) {
            return Buffer.from(wif, 'hex');
        }
    }

    function wrapTxForBtsdexCompat(tx: any, client: any, key: any): any {
        const wrapped = {
            initPromise: _initPromise,

            limit_order_create(data: any): any {
                if (data.on_fill && Array.isArray(data.on_fill)) {
                    data.extensions = data.extensions || {};
                    data.extensions.on_fill = data.on_fill;
                }
                delete data.on_fill;
                return tx.limit_order_create(data);
            },

            limit_order_cancel(data: any): any { return tx.limit_order_cancel(data); },
            limit_order_update(data: any): any { return tx.limit_order_update(data); },
            call_order_update(data: any): any { return tx.call_order_update(data); },
            asset_settle(data: any): any { return tx.asset_settle(data); },
            transfer(data: any): any { return tx.transfer(data); },

            addOperation(type: any, params: any): any { return tx.addOperation(type, params); },

            async broadcast() {
                await tx.prepare();
                const keyBuf = wifToBuffer(key);
                const signed = tx.sign(keyBuf);
                const broadcast = client.broadcast || {};
                const broadcastFn = typeof broadcast.broadcast_transaction_synchronous === 'function'
                    ? broadcast.broadcast_transaction_synchronous.bind(broadcast)
                    : typeof broadcast.broadcast_transaction === 'function'
                        ? broadcast.broadcast_transaction.bind(broadcast)
                        : null;
                if (!broadcastFn) {
                    throw new Error('Broadcast API does not support transaction broadcast');
                }
                let result: any;
                try {
                    result = await broadcastFn(signed.signedTxObject);
                } catch (err: any) {
                    const msg = String(err?.message || err || '');
                    if (/fee/i.test(msg)) {
                        txCache.invalidateFees();
                    }
                    throw err;
                }

                if (result && Array.isArray(result.operation_results)) {
                    return { ...result, operation_results: result.operation_results };
                }

                if (result && result.trx && Array.isArray(result.trx.operation_results)) {
                    return { ...result, operation_results: result.trx.operation_results };
                }

                if (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results)) {
                    return { raw: result, operation_results: result[0].trx.operation_results };
                }

                if (typeof result === 'object' && result !== null && result.id && !result.operation_results) {
                    signingClientLogger.warn('Async broadcast returned no operation_results — tx may not have been processed');
                }

                return { ...result, operation_results: [] };
            },

            setRequiredFees(feeAssetId: any): any {
                return tx.setRequiredFees(feeAssetId);
            },

            getOperationCount() { return tx.getOperationCount(); },
        };

        return new Proxy(wrapped, {
            get(target: any, prop: any): any {
                if (prop === 'sign') {
                    return (keyBuf: any) => tx.sign(keyBuf);
                }
                if (typeof prop === 'string' && !(prop in target)) {
                    return (data: any): any => tx.addOperation(prop, data);
                }
                return (target as any)[prop];
            },
        });
    }

    async function broadcast(operation: any): Promise<any> {
        const tx = newTx();
        if (operation && operation.op_name && typeof (tx as any)[operation.op_name] === 'function') {
            (tx as any)[operation.op_name](operation.op_data);
        } else if (operation && operation.op_name) {
            tx.addOperation(operation.op_name, operation.op_data);
        } else {
            throw new Error('Operation must have op_name and op_data');
        }
        return tx.broadcast();
    }

    return {
        client: {
            initPromise: _initPromise,
            newTx,
            broadcast,
            accountId: _accountId,
            accountName,
        },
        newTx,
        broadcast,
        accountName,
        accountId(): any { return _accountId; },
    };
}

export = { createSigningClient };
