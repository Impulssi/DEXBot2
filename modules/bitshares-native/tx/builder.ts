'use strict';

import { NATIVE_CLIENT } from '../../constants.js';
import { ops as serialOps } from '../serial/index.js';
import getEcc from '../crypto/ecc_selector.js';
import Logger from '../../order/logger.js';
import * as txCache from './tx_cache.js';
import { getErrorMessage } from '../../utils/errors.js';

const { TRANSACTION, CHAIN, OPERATIONS } = NATIVE_CLIENT;
const { sha256, sign } = getEcc();
const builderLogger = new Logger('TxBuilder');

const MAX_TX_SIZE: number = TRANSACTION.MAX_SIZE_BYTES;
const MAX_OPS_PER_TX: number = TRANSACTION.MAX_OPS_PER_TX;
const DEFAULT_EXPIRE_SEC: number = TRANSACTION.DEFAULT_EXPIRE_SEC;
const TX_EXPIRATION_MAX_SEC: number = TRANSACTION.MAX_EXPIRE_SEC;
const DEFAULT_FEE_ASSET: string = CHAIN.CORE_ASSET_ID;
const GRAPHENE_CHAIN_ID: string = CHAIN.CHAIN_ID;

const OP_TYPE_IDS: Record<string, number> = {
    transfer: OPERATIONS.TRANSFER,
    limit_order_create: OPERATIONS.LIMIT_ORDER_CREATE,
    limit_order_cancel: OPERATIONS.LIMIT_ORDER_CANCEL,
    call_order_update: OPERATIONS.CALL_ORDER_UPDATE,
    fill_order: OPERATIONS.FILL_ORDER,
    asset_settle: OPERATIONS.ASSET_SETTLE,
    credit_offer_accept: OPERATIONS.CREDIT_OFFER_ACCEPT,
    credit_deal_repay: OPERATIONS.CREDIT_DEAL_REPAY,
    credit_deal_update: OPERATIONS.CREDIT_DEAL_UPDATE,
    limit_order_update: OPERATIONS.LIMIT_ORDER_UPDATE,
    liquidity_pool_exchange: OPERATIONS.LIQUIDITY_POOL_EXCHANGE,
};

class TransactionTooLargeError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.code = 'TX_TOO_LARGE';
    }
}

type OpParams = Record<string, unknown>;

interface SerializerInstance {
    toBuffer(obj: unknown): Buffer;
    toObject(obj: unknown, debug?: unknown): Record<string, unknown>;
}

interface SerialOps {
    transaction: SerializerInstance;
    signed_transaction: SerializerInstance;
    [key: string]: SerializerInstance | undefined;
}

interface ChainClientRef {
    getConfig?(): { chainId: string } | null;
    transport?: {
        getNodeUrl?(): string | undefined;
    };
    reportNodeFailure?(nodeUrl: string, errorMessage?: string, source?: string): void;
    db: {
        call(method: string, args: unknown[]): Promise<unknown>;
        get_objects(ids: string[]): Promise<unknown[]>;
        get_dynamic_global_properties(): Promise<unknown>;
        [key: string]: (...args: never[]) => Promise<unknown>;
    };
}

interface SignedTxResult {
    signedTx: Buffer;
    signedTxObject: Record<string, unknown>;
    digest: Buffer;
    signature: Buffer;
}

interface TransactionBuilder {
    addOperation(type: string, params: OpParams): this;
    limit_order_create(data: OpParams): this;
    limit_order_cancel(data: OpParams): this;
    limit_order_update(data: OpParams): this;
    call_order_update(data: OpParams): this;
    asset_settle(data: OpParams): this;
    transfer(data: OpParams): this;
    credit_offer_accept(data: OpParams): this;
    credit_deal_repay(data: OpParams): this;
    credit_deal_update(data: OpParams): this;
    liquidity_pool_exchange(data: OpParams): this;
    setRequiredFees(feeAssetId?: string): Promise<void>;
    fetchRefBlock(): Promise<void>;
    setExpiration(seconds?: number): void;
    prepare(feeAssetId?: string): Promise<Buffer>;
    _serializeUnsigned(): Buffer;
    _buildSerializedOp(type: string, params: OpParams): [number, unknown];
    _castParamsToSerializable(type: string, params: OpParams): OpParams;
    sign(privateKey: Buffer): SignedTxResult;
    broadcast(): Promise<never>;
    _getSerializedOps(): Array<[number, unknown]>;
    getOperationCount(): number;
    getOperations(): Array<{ type: string; params: OpParams }>;
}

function getChainIdBuffer(chainClient: ChainClientRef | null): Buffer {
    const chainId = chainClient?.getConfig?.()?.chainId || GRAPHENE_CHAIN_ID;
    if (typeof chainId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(chainId)) {
        throw new Error(`Invalid chain id for transaction signing: ${chainId}`);
    }
    return Buffer.from(chainId, 'hex');
}

function assertTxSize(buffer: Buffer): void {
    if (buffer.length > MAX_TX_SIZE) {
        throw new TransactionTooLargeError(`Serialized transaction size ${buffer.length} exceeds max ${MAX_TX_SIZE}`);
    }
}

function createTransactionBuilder(chainClient: ChainClientRef) {
    const ops: Array<{ type: string; params: OpParams }> = [];
    let refBlockNum = 0;
    let refBlockPrefix = 0;
    let expiration: number | null = null;

    const tx: TransactionBuilder & Record<string, unknown> = {
        addOperation(type: string, params: OpParams) {
            if (ops.length >= MAX_OPS_PER_TX) {
                throw new TransactionTooLargeError(`Max operations per tx (${MAX_OPS_PER_TX}) exceeded`);
            }
            ops.push({ type, params });
            return this;
        },

        limit_order_create(data: OpParams) {
            return this.addOperation('limit_order_create', data);
        },
        limit_order_cancel(data: OpParams) {
            return this.addOperation('limit_order_cancel', data);
        },
        limit_order_update(data: OpParams) {
            return this.addOperation('limit_order_update', data);
        },
        call_order_update(data: OpParams) {
            return this.addOperation('call_order_update', data);
        },
        asset_settle(data: OpParams) {
            return this.addOperation('asset_settle', data);
        },
        transfer(data: OpParams) {
            return this.addOperation('transfer', data);
        },
        credit_offer_accept(data: OpParams) {
            return this.addOperation('credit_offer_accept', data);
        },
        credit_deal_repay(data: OpParams) {
            return this.addOperation('credit_deal_repay', data);
        },
        credit_deal_update(data: OpParams) {
            return this.addOperation('credit_deal_update', data);
        },
        liquidity_pool_exchange(data: OpParams) {
            return this.addOperation('liquidity_pool_exchange', data);
        },

        async setRequiredFees(feeAssetId: string = DEFAULT_FEE_ASSET) {
            if (ops.length === 0) return;

            const opList = this._getSerializedOps();
            const cacheKey = txCache.buildFeeCacheKey(opList, feeAssetId);

            const cachedFees = txCache.getFees(cacheKey);
            if (cachedFees && cachedFees.length === ops.length) {
                for (let i = 0; i < ops.length; i++) {
                    ops[i].params.fee = cachedFees[i];
                }
                return;
            }

            // Stale fallback — save before chain fetch in case it fails
            const stale = txCache.peekFees(cacheKey);

            try {
                const fees = await chainClient.db.call('get_required_fees', [opList, feeAssetId]);
                if (Array.isArray(fees) && fees.length === ops.length) {
                    txCache.setFees(cacheKey, fees);
                    for (let i = 0; i < ops.length; i++) {
                        ops[i].params.fee = fees[i];
                    }
                }
            } catch (err) {
                if (stale && stale.length === ops.length) {
                    builderLogger.info(
                        `setRequiredFees: chain fetch failed (${getErrorMessage(err)}), using stale cached fees`
                    );
                    // Report the failing node to NodeManager (3 strikes → blacklist)
                    try {
                        const nodeUrl = chainClient?.transport?.getNodeUrl?.();
                        if (nodeUrl && typeof chainClient.reportNodeFailure === 'function') {
                            chainClient.reportNodeFailure(nodeUrl, getErrorMessage(err), 'fee-cache');
                        }
                    } catch (_) { /* best-effort */ }
                    for (let i = 0; i < ops.length; i++) {
                        ops[i].params.fee = stale[i];
                    }
                    return;
                }
                throw new Error(`Failed to fetch required fees: ${getErrorMessage(err)}`);
            }
        },

        async fetchRefBlock() {
            try {
                const globals = await chainClient.db.get_objects(['2.0.0', '2.1.0']) as Array<Record<string, unknown>>;
                if (globals && globals.length >= 2) {
                    const dgp = globals[1] as { head_block_number?: unknown; head_block_id?: string } | undefined;
                    if (dgp) {
                        refBlockNum = Number(dgp.head_block_number) & 0xFFFF;
                        refBlockPrefix = Buffer.from(dgp.head_block_id as string, 'hex').readUInt32LE(4);
                        return;
                    }
                }
            } catch (err) { console.warn('[builder]', 'fetchRefBlock (get_objects) failed:', getErrorMessage(err)); }

            try {
                const dgp = await chainClient.db.get_dynamic_global_properties() as { head_block_number?: unknown; head_block_id?: string } | null | undefined;
                if (dgp) {
                    refBlockNum = Number(dgp.head_block_number) & 0xFFFF;
                    try {
                        refBlockPrefix = Buffer.from(dgp.head_block_id as string, 'hex').readUInt32LE(4);
                    } catch (err2) {
                        refBlockPrefix = 0;
                    }
                    return;
                }
            } catch (err2) {
                // Fallback attempts exhausted below
            }

            throw new Error('Failed to fetch reference block for transaction (head_block_id via get_objects and get_dynamic_global_properties both failed)');
        },

        setExpiration(seconds: number = DEFAULT_EXPIRE_SEC) {
            const expireSeconds = Math.min(seconds, TX_EXPIRATION_MAX_SEC);
            const expireDate = new Date(Date.now() + expireSeconds * 1000);
            expiration = Math.floor(expireDate.getTime() / 1000);
        },

        async prepare(feeAssetId: string = DEFAULT_FEE_ASSET) {
            await this.fetchRefBlock();
            if (!expiration) this.setExpiration();
            await this.setRequiredFees(feeAssetId);
            return this._serializeUnsigned();
        },



        _serializeUnsigned() {
            const unsignedOps: Array<[number, unknown]> = [];
            for (const { type, params } of ops) {
                unsignedOps.push(this._buildSerializedOp(type, params));
            }

            const txData = {
                ref_block_num: refBlockNum,
                ref_block_prefix: refBlockPrefix,
                expiration: expiration || (Math.floor(Date.now() / 1000) + DEFAULT_EXPIRE_SEC),
                operations: unsignedOps,
                extensions: [],
            };

            const buffer = (serialOps as unknown as SerialOps).transaction.toBuffer(txData);
            assertTxSize(buffer);
            return buffer;
        },

        _buildSerializedOp(type: string, params: OpParams): [number, unknown] {
            const typeId = OP_TYPE_IDS[type];
            const serializer = (serialOps as unknown as SerialOps)[type];

            if (typeId === undefined || !serializer) {
                throw new Error(`Unknown operation type: ${type}`);
            }

            const castFn = this._castParamsToSerializable(type, params);

            return [typeId, castFn];
        },

        _castParamsToSerializable(type: string, params: OpParams): OpParams {
            const result: OpParams = { ...params };

            result.fee = result.fee || { amount: 0, asset_id: DEFAULT_FEE_ASSET };

            if (result.delta_amount_to_sell) {
                result.delta_amount_to_sell = { ...result.delta_amount_to_sell };
            }

            if (type === 'limit_order_update') {
                if (result.new_price) {
                    const np = result.new_price as Record<string, unknown>;
                    result.new_price = {
                        ...np,
                        base: { ...(np.base as Record<string, unknown>) },
                        quote: { ...(np.quote as Record<string, unknown>) },
                    };
                }
            }

            if (result.amount_to_sell) result.amount_to_sell = { ...result.amount_to_sell };
            if (result.min_to_receive) result.min_to_receive = { ...result.min_to_receive };
            if (result.amount) result.amount = { ...result.amount };
            if (result.borrow_amount) result.borrow_amount = { ...result.borrow_amount };
            if (result.collateral) result.collateral = { ...result.collateral };
            if (result.repay_amount) result.repay_amount = { ...result.repay_amount };
            if (result.credit_fee) result.credit_fee = { ...result.credit_fee };

            return result;
        },

        sign(privateKey: Buffer) {
            const unsignedTx = this._serializeUnsigned();
            const digest = sha256(Buffer.concat([getChainIdBuffer(chainClient), unsignedTx]));

            const sig = sign(digest, privateKey);

            const opList: Array<[number, unknown]> = [];
            for (const { type, params } of ops) {
                opList.push(this._buildSerializedOp(type, params));
            }

            const txData = {
                ref_block_num: refBlockNum,
                ref_block_prefix: refBlockPrefix,
                expiration: expiration || (Math.floor(Date.now() / 1000) + DEFAULT_EXPIRE_SEC),
                operations: opList,
                extensions: [],
                signatures: [sig],
            };

            const signedTx = (serialOps as unknown as SerialOps).signed_transaction.toBuffer(txData);
            assertTxSize(signedTx);

            const txDataForJson = {
                ...txData,
                signatures: [sig.toString('hex')],
            };
            const signedTxObject = (serialOps as unknown as SerialOps).signed_transaction.toObject(txDataForJson) as Record<string, unknown>;

            return {
                signedTx,
                signedTxObject,
                digest,
                signature: sig,
            };
        },

        async broadcast() {
            throw new Error('TransactionBuilder.broadcast() not implemented; use createSigningClient wrapper');
        },

        _getSerializedOps(): Array<[number, unknown]> {
            return ops.map(o => this._buildSerializedOp(o.type, o.params));
        },

        getOperationCount(): number { return ops.length; },
        getOperations(): Array<{ type: string; params: OpParams }> { return [...ops]; },
    };

    return tx;
}

export { createTransactionBuilder, TransactionTooLargeError, MAX_TX_SIZE, MAX_OPS_PER_TX }

