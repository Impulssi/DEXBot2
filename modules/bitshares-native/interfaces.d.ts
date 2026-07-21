declare module 'bitshares-native' {
    export interface Asset {
        amount: number;
        asset_id: string;
    }

    export interface Price {
        base: Asset;
        quote: Asset;
    }

    export interface LimitOrderCreateOp {
        fee: Asset;
        seller: string;
        amount_to_sell: Asset;
        min_to_receive: Asset;
        expiration: string;
        fill_or_kill: boolean;
        extensions?: object;
    }

    export interface LimitOrderCancelOp {
        fee: Asset;
        fee_paying_account: string;
        order: string;
        extensions?: any[];
    }

    export interface LimitOrderUpdateOp {
        fee: Asset;
        seller: string;
        order: string;
        new_price?: Price;
        delta_amount_to_sell?: Asset;
        new_expiration?: string;
        on_fill?: any[];
        extensions?: any[];
    }

    export interface CallOrderUpdateOp {
        fee: Asset;
        funding_account: string;
        delta_collateral: Asset;
        delta_debt: Asset;
        extensions?: object;
    }

    export interface AssetSettleOp {
        fee: Asset;
        account: string;
        amount: Asset;
        extensions?: any[];
    }

    export interface TransferOp {
        fee: Asset;
        from: string;
        to: string;
        amount: Asset;
        memo?: any;
        extensions?: any[];
    }

    export interface ChainConfig {
        chainId: string;
        addressPrefix: string;
        coreAsset: string;
    }

    export interface TxBuilder {
        addOperation(type: string, params: object): TxBuilder;
        limit_order_create(data: LimitOrderCreateOp): TxBuilder;
        limit_order_cancel(data: LimitOrderCancelOp): TxBuilder;
        limit_order_update(data: LimitOrderUpdateOp): TxBuilder;
        call_order_update(data: CallOrderUpdateOp): TxBuilder;
        asset_settle(data: AssetSettleOp): TxBuilder;
        transfer(data: TransferOp): TxBuilder;
        setRequiredFees(feeAssetId?: string): Promise<void>;
        sign(privateKey: Buffer): { signedTx: Buffer; digest: Buffer; signature: Buffer };
        broadcast(): Promise<any>;
        getOperationCount(): number;
    }

    export interface BtsdexCompatTx extends TxBuilder {
        initPromise: Promise<void>;
    }

    export interface ChainClient {
        connect(nodes?: string[]): Promise<void>;
        disconnect(): void;
        setNodes(nodes: string[]): void;
        getNodes(): string[];
        getStatus(): string;
        getConfig(): ChainConfig | null;
        getCoreAsset(): string;
        db: {
            get_assets(ids: string[]): Promise<any[]>;
            lookup_asset_symbols(symbols: string[]): Promise<any[]>;
            get_full_accounts(ids: string[], subscribe: boolean): Promise<any[][]>;
            get_order_book(base: string, quote: string, depth: number): Promise<any>;
            get_ticker(base: string, quote: string): Promise<any>;
            get_objects(ids: string[]): Promise<any[]>;
            getGlobalProperties(): Promise<any>;
            get_dynamic_global_properties(): Promise<any>;
            get_liquidity_pools_by_both_assets(a: string, b: string, limit?: number, start_id?: string, with_statistics?: boolean): Promise<any[]>;
            get_liquidity_pools_by_share_asset(shares: string[]): Promise<any[]>;
            list_liquidity_pools(...args: any[]): Promise<any[]>;
            get_call_orders(...args: any[]): Promise<any[]>;
            list_assets(...args: any[]): Promise<any[]>;
            get_account_count(): Promise<number>;
            call(method: string, args: any[]): Promise<any>;
            [key: string]: (...args: any[]) => Promise<any>;
        };
        history: {
            getMarketHistory(...args: any[]): Promise<any[]>;
            getMarketHistoryBuckets(): Promise<any>;
            get_account_history_by_operations(...args: any[]): Promise<any[]>;
            getAccountHistory(...args: any[]): Promise<any[]>;
            get_liquidity_pool_history(...args: any[]): Promise<any[]>;
            get_liquidity_pool_history_by_sequence(...args: any[]): Promise<any[]>;
            get_relative_account_history(...args: any[]): Promise<any[]>;
            call(method: string, args: any[]): Promise<any>;
        };
        broadcast: {
            broadcast_transaction(tx: Buffer): Promise<any>;
            call(method: string, args: any[]): Promise<any>;
        };
        transport: any;
        login(): Promise<ChainConfig>;
    }

    export interface ReadOnlyClient {
        connect(nodes?: string[]): Promise<void>;
        disconnect(): void;
        db(method: string, args: any[]): Promise<any>;
        history(method: string, args: any[]): Promise<any>;
        setNodes(nodes: string[]): void;
        getNodes(): string[];
        getNodeUrl(): string | null;
        isConnected(): boolean;
    }

    export interface SigningClient {
        newTx(): BtsdexCompatTx;
        accountName: string;
        accountId(): string | null;
        client: {
            initPromise: Promise<void>;
            newTx(): BtsdexCompatTx;
            accountId: string | null;
            accountName: string;
        };
        dispose(): void;
    }

    export function createTransport(config?: object): any;
    export function createChainClient(config?: object): ChainClient;
    export function createReadOnlyClient(config?: object): ReadOnlyClient;
    export function createSubscriptionManager(chainClient: ChainClient): any;
    export function createSigningClient(
        chainClient: ChainClient,
        accountName: string,
        privateKey: Buffer | string
    ): SigningClient;
    export function createResolvers(chainClient: ChainClient): any;

    export class ConnectionError extends Error { code: string; }
    export class AllNodesFailed extends Error { code: string; errors: Error[]; }
    export class RpcError extends Error { code: string; method: string; params: any[]; }
    export class RpcTimeoutError extends Error { code: string; method: string; }
    export class ChainConfigError extends Error { code: string; }
    export class TransactionTooLargeError extends Error { code: string; }
    export class BroadcastError extends Error { code: string; result: any; }

    export const GRAPHENE_CHAIN_ID: string;
    export const GRAPHENE_ADDRESS_PREFIX: string;
    export const GRAPHENE_BLOCKCHAIN_PRECISION: number;
}
