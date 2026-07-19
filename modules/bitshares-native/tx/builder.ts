'use strict';

const { NATIVE_CLIENT } = require('../../constants');
const { TRANSACTION, CHAIN } = NATIVE_CLIENT;
const { ops: serialOps } = require('../serial');
const getEcc = require('../crypto/ecc_selector');
const { sha256, sign } = getEcc();
const txCache = require('./tx_cache');

const MAX_TX_SIZE: number = TRANSACTION.MAX_SIZE_BYTES;
const MAX_OPS_PER_TX: number = TRANSACTION.MAX_OPS_PER_TX;
const DEFAULT_EXPIRE_SEC: number = TRANSACTION.DEFAULT_EXPIRE_SEC;
const TX_EXPIRATION_MAX_SEC: number = TRANSACTION.MAX_EXPIRE_SEC;
const DEFAULT_FEE_ASSET: string = CHAIN.CORE_ASSET_ID;
const GRAPHENE_CHAIN_ID: string = CHAIN.CHAIN_ID;

const OP_TYPE_IDS: Record<string, number> = {
    transfer: 0,
    limit_order_create: 1,
    limit_order_cancel: 2,
    call_order_update: 3,
    fill_order: 4,
    asset_settle: 17,
    credit_offer_accept: 72,
    credit_deal_repay: 73,
    credit_deal_update: 76,
    limit_order_update: 77,
    liquidity_pool_exchange: 63,
};

class TransactionTooLargeError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.code = 'TX_TOO_LARGE';
    }
}

class BroadcastError extends Error {
    code: string;
    result: any;
    constructor(message: string, result: any) {
        super(message);
        this.code = 'BROADCAST_ERROR';
        this.result = result;
    }
}

interface SerializerInstance {
    toBuffer(obj: any): Buffer;
    toObject(obj: any, debug?: any): Record<string, any>;
}

interface SerialOps {
    transaction: SerializerInstance;
    signed_transaction: SerializerInstance;
    [key: string]: SerializerInstance | undefined;
}

interface ChainClientRef {
    getConfig?(): { chainId: string } | null;
    db: {
        call(method: string, args: any[]): Promise<any>;
        get_objects(ids: string[]): Promise<any[]>;
        get_dynamic_global_properties(): Promise<any>;
        [key: string]: (...args: any[]) => Promise<any>;
    };
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
    const ops: Array<{ type: string; params: any }> = [];
    let refBlockNum = 0;
    let refBlockPrefix = 0;
    let expiration: number | null = null;

    const tx: any = {
        addOperation(type: string, params: any) {
            if (ops.length >= MAX_OPS_PER_TX) {
                throw new TransactionTooLargeError(`Max operations per tx (${MAX_OPS_PER_TX}) exceeded`);
            }
            ops.push({ type, params });
            return this;
        },

        limit_order_create(data: any) {
            return this.addOperation('limit_order_create', data);
        },
        limit_order_cancel(data: any) {
            return this.addOperation('limit_order_cancel', data);
        },
        limit_order_update(data: any) {
            return this.addOperation('limit_order_update', data);
        },
        call_order_update(data: any) {
            return this.addOperation('call_order_update', data);
        },
        asset_settle(data: any) {
            return this.addOperation('asset_settle', data);
        },
        transfer(data: any) {
            return this.addOperation('transfer', data);
        },
        credit_offer_accept(data: any) {
            return this.addOperation('credit_offer_accept', data);
        },
        credit_deal_repay(data: any) {
            return this.addOperation('credit_deal_repay', data);
        },
        credit_deal_update(data: any) {
            return this.addOperation('credit_deal_update', data);
        },
        liquidity_pool_exchange(data: any) {
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

            try {
                const fees = await chainClient.db.call('get_required_fees', [opList, feeAssetId]);
                if (Array.isArray(fees) && fees.length === ops.length) {
                    txCache.setFees(cacheKey, fees);
                    for (let i = 0; i < ops.length; i++) {
                        ops[i].params.fee = fees[i];
                    }
                }
            } catch (err: any) {
                throw new Error(`Failed to fetch required fees: ${err.message}`);
            }
        },

        async fetchRefBlock() {
            try {
                const globals = await chainClient.db.get_objects(['2.0.0', '2.1.0']);
                if (globals && globals.length >= 2) {
                    const dgp = globals[1];
                    if (dgp) {
                        refBlockNum = Number(dgp.head_block_number) & 0xFFFF;
                        refBlockPrefix = Buffer.from(dgp.head_block_id, 'hex').readUInt32LE(4);
                        return;
                    }
                }
            } catch (err: any) { console.warn('[builder]', 'fetchRefBlock (get_objects) failed:', err.message); }

            try {
                const dgp = await chainClient.db.get_dynamic_global_properties();
                if (dgp) {
                    refBlockNum = Number(dgp.head_block_number) & 0xFFFF;
                    try {
                        refBlockPrefix = Buffer.from(dgp.head_block_id, 'hex').readUInt32LE(4);
                    } catch (err2: any) {
                        refBlockPrefix = 0;
                    }
                    return;
                }
            } catch (err2: any) {
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
            const unsignedOps: Array<[number, any]> = [];
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

            const buffer = (serialOps as SerialOps).transaction.toBuffer(txData);
            assertTxSize(buffer);
            return buffer;
        },

        _buildSerializedOp(type: string, params: any): [number, any] {
            const typeId = OP_TYPE_IDS[type];
            const serializer = (serialOps as SerialOps)[type];

            if (typeId === undefined || !serializer) {
                throw new Error(`Unknown operation type: ${type}`);
            }

            const castFn = this._castParamsToSerializable(type, params);

            return [typeId, castFn];
        },

        _castParamsToSerializable(type: string, params: any): any {
            const result: any = { ...params };

            result.fee = result.fee || { amount: 0, asset_id: DEFAULT_FEE_ASSET };

            if (result.delta_amount_to_sell) {
                result.delta_amount_to_sell = { ...result.delta_amount_to_sell };
            }

            if (type === 'limit_order_update') {
                if (result.new_price) {
                    result.new_price = {
                        ...result.new_price,
                        base: { ...result.new_price.base },
                        quote: { ...result.new_price.quote },
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

            const opList: Array<[number, any]> = [];
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

            const signedTx = (serialOps as SerialOps).signed_transaction.toBuffer(txData);
            assertTxSize(signedTx);

            const txDataForJson = {
                ...txData,
                signatures: [sig.toString('hex')],
            };
            const signedTxObject = (serialOps as SerialOps).signed_transaction.toObject(txDataForJson);

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

        _getSerializedOps(): Array<[number, any]> {
            return ops.map(o => this._buildSerializedOp(o.type, o.params));
        },

        getOperationCount(): number { return ops.length; },
        getOperations(): Array<{ type: string; params: any }> { return [...ops]; },
    };

    return tx;
}

export = {
    createTransactionBuilder,
    TransactionTooLargeError,
    BroadcastError,
    MAX_TX_SIZE,
    MAX_OPS_PER_TX,
};
