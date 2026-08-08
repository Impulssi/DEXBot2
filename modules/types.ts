/**
 * DEXBot2 Central Type Definitions
 *
 * Where possible, types align with the BitShares C++ protocol headers
 * at https://github.com/bitshares/bitshares-core
 *
 * See libraries/protocol/include/graphene/protocol/ for canonical defs.
 */

// ============================================================
// STRING LITERAL ENUMS
// ============================================================

export type OrderType = 'sell' | 'buy' | 'spread';
export type OrderState = 'virtual' | 'active' | 'partial' | 'filled';
export type RebalanceState = 'NORMAL' | 'REBALANCING' | 'BROADCASTING';
export type GridPriceSource = 'pool' | 'book' | 'ama' | 'ama1' | 'ama2' | 'ama3' | 'ama4' | number | null;
export type StartPriceSource = 'pool' | 'book' | number;
// ============================================================
// PRIMITIVE BLOCKCHAIN TYPES
// Matches graphene::protocol::asset (asset.hpp)
// ============================================================

export interface Asset {
  /** Integer amount in satoshis (blockchain precision) */
  amount: number;
  /** Blockchain asset ID, e.g. "1.3.0" */
  asset_id: string;
}

/** Exchange ratio between two assets. Matches graphene::protocol::price (asset.hpp:108-114) */
export interface Price {
  base: Asset;
  quote: Asset;
}

// ============================================================
// BLOCKCHAIN ORDER STRUCTURES
// ============================================================

/** Normalized order parsed from a chain order object */
export interface ParsedChainOrder {
  orderId: string;
  price: number;
  type: 'buy' | 'sell';
  size: number;
}

/** Raw fill data from a fill_order_operation (op[1]). Matches graphene::protocol::fill_order_operation */
export interface FillOperationData {
  order_id: string;
  account_id: string;
  pays: Asset;
  receives: Asset;
  fee: Asset;
  fill_price: Price;
  is_maker: boolean;
}

/** Raw fill event from blockchain subscription or history query */
export interface FillEvent {
  id: string;
  block_num: number;
  op: [number, FillOperationData];
}

// ============================================================
// OPERATION BUILDERS
// ============================================================

export interface LimitOrderCreateOp {
  fee: Asset;
  seller: string;
  amount_to_sell: Asset;
  min_to_receive: Asset;
  expiration: string;
  fill_or_kill: boolean;
  extensions?: Record<string, any>;
}

export interface LimitOrderUpdateOp {
  fee: Asset;
  seller: string;
  order: string;
  new_price?: Price;
  delta_amount_to_sell?: Asset;
  new_expiration?: string;
  on_fill?: Array<Record<string, any>>;
  extensions?: Record<string, any>;
}

export interface LimitOrderCancelOp {
  fee: Asset;
  fee_paying_account: string;
  order: string;
  extensions?: Record<string, any>;
}

export interface CallOrderUpdateOp {
  fee: Asset;
  funding_account: string;
  delta_collateral: Asset;
  delta_debt: Asset;
  extensions?: Record<string, any>;
}

export interface AssetSettleOp {
  fee: Asset;
  account: string;
  amount: Asset;
  extensions?: Record<string, any>;
}

export interface TransferOp {
  fee: Asset;
  from: string;
  to: string;
  amount: Asset;
  memo?: Record<string, any>;
  extensions?: Record<string, any>;
}

export interface CreatedOperation {
  op_name: string;
  op_data: Record<string, any>;
}

// ============================================================
// CHAIN / BROADCAST RESULT TYPES
// ============================================================

export interface BroadcastResult {
  success: boolean;
  raw?: any;
  operation_results?: any[];
}

// ============================================================
// DOMAIN: ORDER (DISCRIMINATED UNION)
// ============================================================

export interface OrderBase {
  id: string;
  price: number;
  type: OrderType;
  state: OrderState;
  size: number;
  orderId: string | null;
  committedSide?: OrderType;
  rawOnChain?: { for_sale?: number };
  metadata?: Record<string, any>;
  gridIndex?: number;
  idealSize?: number;
  sideHint?: string;
}

export interface VirtualOrder extends OrderBase {
  state: 'virtual';
  orderId: null | '';
}

export interface ActiveOrder extends OrderBase {
  state: 'active';
  orderId: string;
  size: number;
}

export interface PartialOrder extends OrderBase {
  state: 'partial';
  orderId: string;
  size: number;
}

export type Order = VirtualOrder | ActiveOrder | PartialOrder;

export interface OrderValidationError {
  code: string;
  message: string;
  isFatal?: boolean;
  autoCorrect?: Record<string, any>;
}

export interface OrderValidationWarning {
  code: string;
  message: string;
}

export interface OrderValidationResult {
  isValid: boolean;
  errors: OrderValidationError[];
  warnings: OrderValidationWarning[];
  normalizedOrder: Order | null;
}

export interface PersistenceValidationResult {
  isValid: boolean;
  reason: string | null;
}

// ============================================================
// DOMAIN: GRID
// ============================================================

export interface GridConfig {
  startPrice: number;
  minPrice: number;
  maxPrice: number;
  incrementPercent: number;
  targetSpreadPercent: number;
  activeOrders: { sell: number; buy: number };
  botFunds: { sell: string | number; buy: string | number };
  weightDistribution: { sell: number; buy: number };
  gridPrice?: GridPriceSource;
}

export interface GridOrderSlot {
  id: string;
  price: number;
  type: OrderType | null;
  state: 'virtual';
  size: 0;
}

export interface GridCreationResult {
  orders: GridOrderSlot[];
  boundaryIdx: number;
  initialSpreadCount: { buy: number; sell: number };
}

export interface SizingContext {
  budget: number;
  precision: number;
  config: Record<string, any>;
}

export interface GridComparisonResult {
  buy: { metric: number; updated: boolean };
  sell: { metric: number; updated: boolean };
  totalMetric: number;
}

export interface DivergenceResult {
  needsUpdate: boolean;
  buy: { updated: boolean; ratio: boolean; rms: boolean; metric: number };
  sell: { updated: boolean; ratio: boolean; rms: boolean; metric: number };
  orderType: 'buy' | 'sell' | 'both';
}

export interface SpreadCorrectionResult {
  ordersToPlace: Order[];
  ordersToUpdate: Array<{ partialOrder: Order; newSize: number }>;
}

export interface DustCheckResult {
  buyDust: boolean;
  sellDust: boolean;
  buyDustOrders: Order[];
  sellDustOrders: Order[];
}

export interface SideUpdateFlags {
  buyUpdated: boolean;
  sellUpdated: boolean;
}

export interface SpreadCheckResult {
  ordersPlaced: number;
  partialsMoved: number;
}

// ============================================================
// DOMAIN: FUNDS / ACCOUNTING
// ============================================================

export interface SideFunds {
  sell: number;
  buy: number;
}

export interface AccountTotals {
  buy: number | null;
  sell: number | null;
  buyFree: number | null;
  sellFree: number | null;
}

export interface ChainFundsSnapshot {
  chainTotalBuy: number;
  chainTotalSell: number;
  allocatedBuy: number;
  allocatedSell: number;
}

// ============================================================
// DOMAIN: COPY-ON-WRITE (COW)
// ============================================================

export interface CowCreateAction {
  type: 'create';
  id: string;
  order: Order;
}

export interface CowCancelAction {
  type: 'cancel';
  id: string;
  orderId: string;
  reason?: string;
}

export interface CowUpdateAction {
  type: 'update';
  id: string;
  orderId: string;
  newGridId: string;
  newSize: number;
  newPrice: number;
  order: Order;
  isRotation: boolean;
}

export type CowAction = CowCreateAction | CowCancelAction | CowUpdateAction;

export interface StateUpdate {
  id: string;
  state?: 'virtual';
  orderId?: null;
  type?: 'spread';
  size?: 0 | number;
}

export interface ActionSummary {
  total: number;
  creates: number;
  cancels: number;
  updates: number;
}

export interface CowRebalanceSuccessResult {
  actions: CowAction[];
  stateUpdates: StateUpdate[];
  hadRotation: boolean;
  workingGrid: WorkingGrid;
  workingIndexes: GridIndexes;
  workingBoundary: number;
  planningDuration: number;
  aborted: false;
}

export interface CowRebalanceAbortedResult {
  actions: [];
  stateUpdates: [];
  hadRotation: false;
  workingGrid: null;
  workingIndexes: null;
  workingBoundary: null;
  planningDuration: 0;
  aborted: true;
  reason: string;
}

export type CowRebalanceResult = CowRebalanceSuccessResult | CowRebalanceAbortedResult;

export interface ReconcileResult {
  actions: CowAction[];
  aborted: false;
  boundaryIdx: number;
  summary: ActionSummary;
}

export interface DriftCheckResult {
  isValid: boolean;
  driftBuy: number;
  driftSell: number;
  allowedDriftBuy: number;
  allowedDriftSell: number;
  reason: string | null;
}

export interface BootstrapResult {
  hadDrift: boolean;
  driftInfo: DriftCheckResult | null;
}

// ============================================================
// DOMAIN: WORKING GRID / INDEXES
// ============================================================

export interface WorkingGrid {
  grid: Map<string, Order>;
  modified: Set<string>;
  baseVersion: number;
  _stale: boolean;
  _staleReason: string | null;
  _indexes: GridIndexes | null;
}

export interface GridIndexes {
  virtual: Set<string>;
  active: Set<string>;
  partial: Set<string>;
  filled: Set<string>;
  buy: Set<string>;
  sell: Set<string>;
  spread: Set<string>;
}

// ============================================================
// DOMAIN: STRATEGY / TARGET GRID
// ============================================================
// ============================================================
// DOMAIN: SYNC ENGINE
// ============================================================

export interface SyncResult {
  filledOrders: Order[];
  updatedOrders: Order[];
  ordersNeedingCorrection?: PriceCorrectionEntry[];
  unmatchedChainOrders?: any[];
  partialFill?: boolean;
  requiresOpenOrdersSync?: boolean;
}

export interface BatchSyncResult extends SyncResult {
}

export interface PriceCorrectionEntry {
  gridOrder: Order;
  chainOrderId: string;
  expectedPrice: number;
  actualPrice: number;
  size: number;
  type: 'buy' | 'sell';
  typeMismatch?: boolean;
  isSurplus?: boolean;
  sideUpdated?: string;
}

// ============================================================
// DOMAIN: STATE MANAGER / PIPELINE
// ============================================================

export interface GridRegenSideState {
  armed: boolean;
  lastTriggeredAt: number;
}

export interface PipelineState {
  state: RebalanceState;
  currentWorkingGrid: WorkingGrid | null;
}

export interface RecoveryState {
  attemptCount: number;
  lastAttemptAt: number;
  inFlight: boolean;
  lastFailureAt: number;
}

export interface ManagerStateSnapshot {
  rebalance: PipelineState;
  recovery: RecoveryState;
  gridRegen: { buy: GridRegenSideState; sell: GridRegenSideState };
  bootstrap: { isBootstrapping: boolean };
  broadcast: { isBroadcasting: boolean; startedAt: number };
  pipeline: { blockedSince: number | null; recoveryAttempted: boolean };
}

export interface Metrics {
  fundRecalcCount: number;
  lockAcquisitions: number;
  lockContentionSkips: number;
  gridLockContention: number;
  spreadRoleConversionBlocked: number;
  lastSyncDurationMs: number;
  metricsStartTime: number;
  state: ManagerStateSnapshot;
  currentTime: number;
}

export interface PipelineHealth {
  isBlocked: boolean;
  blockedDurationMs: number;
  hasStalled: boolean;
  recoveryAttempted: boolean;
  correctionsPending: number;
  gridSidesUpdated: number;
}

export interface PipelineEmptyResult {
  isEmpty: boolean;
  reasons: string[];
}

export interface OrderUpdateOptions {
  skipAccounting?: boolean;
  fee?: number;
}

// ============================================================
// DOMAIN: STARTUP RECONCILE
// ============================================================
// ============================================================
// DOMAIN: FILL PROCESSING / RUNTIME
// ============================================================

export interface ReplaySafeFillResult {
  status: 'applied' | 'duplicate' | 'missing_key' | 'error';
  fillKey: string | null;
  usedFallbackKey?: boolean;
  error?: Error;
}

export interface BotsConfigSnapshot {
  exists: boolean;
  fingerprint: string | null;
  config?: Record<string, any>;
  activeBots: BotConfigEntry[];
  needsMarketAdapter: boolean;
}

export interface DynamicWeightRefreshResult {
  applied: boolean;
  source: 'static' | 'dynamic';
  weightDistribution: { sell: number; buy: number } | null;
  snapshotUpdatedAt?: string | null;
}

export interface GridResyncMetadata {
  shouldRefreshCenterPrice: boolean;
  centerRefreshContext: string;
  centerRefreshLabel: string;
  resetSource: string;
  payload?: any;
}

export interface GridResyncOptions {
  refreshCenterPrice: boolean;
  centerRefreshContext?: string;
  centerRefreshLabel?: string;
  resetSource?: string;
}

export interface MarketAdapterSyncResult {
  changed: boolean;
  required: boolean;
  running: boolean;
  started: boolean;
  stopped: boolean;
  mode: 'direct' | 'pm2';
  skipped?: boolean;
  reason?: string;
  error?: string;
}

export interface MarketAdapterReleaseResult {
  released: boolean;
  mode: 'direct' | 'pm2';
  reason?: string;
  context?: string;
}

// ============================================================
// DOMAIN: ASSET INFO
// ============================================================

export interface AssetInfo {
  id: string;
  symbol: string;
  precision: number;
}

export interface AssetsPair {
  assetA: AssetInfo;
  assetB: AssetInfo;
}

// ============================================================
// DOMAIN: CONFIGURATION
// ============================================================

export interface BotLoggingOverrides {
  level?: string;
  config?: Partial<LoggingConfig>;
}

export interface BotGridLimitsOverrides {
  minSpreadFactor?: number;
  minOrderSizeFactor?: number;
  gridRegenerationPercentage?: number;
  partialDustThresholdPercentage?: number;
  fundInvariantPercentTolerance?: number;
  minSpreadOrders?: number;
  gridComparison?: { rmsPercentage?: number };
  priceDriftToleranceMultiplier?: number;
  relativeOrderUpdateThresholdPercent?: number;
}

export interface BotFeeParamsOverrides {
  btsReservationMultiplier?: number;
  btsFallbackFee?: number;
  makerFeePercent?: number;
  makerRefundPercent?: number;
  takerFeePercent?: number;
  defaultMaxFeeRatePerDay?: number;
  grapheneFeeRateDenom?: number;
  grapheneCollateralRatioDenom?: number;
  btsAcquireThreshold?: number;
  btsAcquireTargetMultiplier?: number;
  poolSlippageTolerance?: number;
}

export interface BotTimingOverrides {
  openOrdersSyncLoopEnabled?: boolean;
  btsAcquireCooldownMin?: number;
  blockchainFetchIntervalMin?: number;
  creditDealCheckIntervalMin?: number;
  checkIntervalMs?: number;
  runLoopDefaultMs?: number;
  lockTimeoutMs?: number;
  syncLockTimeoutMs?: number;
  connectionTimeoutMs?: number;
  daemonStartupTimeoutMs?: number;
  targetedDriftSyncCooldownMs?: number;
  safetyNetSyncTimeoutMs?: number;
  logThrottleIntervalMs?: number;
  lockRefreshMinMs?: number;
  fillDedupeWindowMs?: number;
  fillRecordRetentionMs?: number;
}

export interface BotIncrementBoundsOverrides {
  minPercent?: number;
  maxPercent?: number;
  minFactor?: number;
  maxFactor?: number;
}

export interface BotFillProcessingOverrides {
  maxFillBatchSize?: number;
  maxConsecutiveConsumerFailures?: number;
  consumerBackoffInitialMs?: number;
  consumerBackoffMaxMs?: number;
}

export interface BotPipelineTimingOverrides {
  timeoutMs?: number;
  recoveryRetryIntervalMs?: number;
  maxRecoveryAttempts?: number;
  recoveryDecayFallbackMs?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface BotApiLimitsOverrides {
  poolBatchSize?: number;
  maxPoolScanBatches?: number;
  orderbookDepth?: number;
  limitOrdersBatch?: number;
  lpApiMaxPage?: number;
}

export interface BotConfigEntry {
  name: string;
  active: boolean;
  dryRun: boolean;
  preferredAccount: string;
  assetA: string;
  assetB: string;
  startPrice: StartPriceSource;
  minPrice: number | string;
  maxPrice: number | string;
  incrementPercent: number;
  targetSpreadPercent: number;
  weightDistribution: { sell: number; buy: number };
  botFunds: { sell: string | number; buy: string | number };
  activeOrders: { sell: number; buy: number };
  gridPrice: GridPriceSource;
  gridPriceOffsetPct?: number;
  poolRef?: string;
  debtPolicy?: DebtPolicy;
  logging?: BotLoggingOverrides;
  gridLimits?: BotGridLimitsOverrides;
  feeParams?: BotFeeParamsOverrides;
  timing?: BotTimingOverrides;
  incrementBounds?: BotIncrementBoundsOverrides;
  fillProcessing?: BotFillProcessingOverrides;
  pipelineTiming?: BotPipelineTimingOverrides;
  apiLimits?: BotApiLimitsOverrides;
}

export interface BotAmaConfig {
  enabled: boolean;
  erPeriod: number;
  fastPeriod: number;
  slowPeriod: number;
  erSmoothPeriod: number;
}

export interface DebtPolicy {
  lending: DebtPolicyLendingEntry[];
}

export interface LendingEntryBase {
  asset: string;
  collateralAsset: string;
  /** @deprecated Use `outputWeight` instead. */
  ratio?: number;
  outputWeight?: number;
  maxBorrowAmount?: number;
  /** Max debt per single borrow operation (per-op cap, independent of
   * maxBorrowAmount's total ceiling). When a deal exceeds this, maintenance
   * splits it into equal pieces ≤ this value via repay+reborrow cycles with
   * 6s spacing. Only applies to `creditOffer` type; `mpa` uses the same
   * field to cap one-shot debt increases in CR-adjustment plans. */
  maxBorrowAmountPerOperation?: number;
  maxCollateralAmount?: number | string;
  minCollateralIncreaseThreshold?: number | string;
  maxCollateralRatio?: number;
}

export interface MpaLendingEntry extends LendingEntryBase {
  type: 'mpa';
  targetCollateralRatio?: number;
  minCollateralRatio?: number;
  debtOnly?: boolean;
}

export interface CreditOfferLendingEntry extends LendingEntryBase {
  type: 'creditOffer';
  maxCollateralRatio: number;
  maxFeeRatePerDay?: number;
  autoReborrow?: boolean;
  autoRepay?: number;
  allowedOfferIds?: string[];
  disallowedDealIds?: string[];
  renewOnly?: boolean;
  minDurationSeconds?: number;
}

export type DebtPolicyLendingEntry = MpaLendingEntry | CreditOfferLendingEntry;

export interface LoggingRotationConfig {
  enabled: boolean;
  maxSize: number;
  maxFiles: number;
}

export interface LoggingJsonConfig {
  enabled: boolean;
}

export interface LoggingConfig {
  changeTracking?: {
    enabled: boolean;
    ignoreMinor?: {
      fundPrecision: number;
      pricePrecision: number;
    };
  };
  categories?: Record<string, {
    enabled: boolean;
    level: string;
    options?: Record<string, any>;
  }>;
  rotation?: LoggingRotationConfig;
  json?: LoggingJsonConfig;
  display?: Record<string, any>;
}

// ============================================================
// DOMAIN: KEY MANAGEMENT
// ============================================================

export interface KeysFile {
  vaultVersion: number;
  vaultSalt: string;
  vaultVerifier: string;
  masterPasswordHash?: string;
  accounts: Record<string, { encryptedKey: string }>;
}

export interface VaultSecret {
  kind: 'dexbot-vault-secret';
  version: number;
  vaultKeyHex: string;
}

// ============================================================
// DOMAIN: MARKET ADAPTER
// ============================================================

export interface MarketAdapterConfig {
  pollSeconds: number;
  deltaThresholdPercent: number;
  amaSlopeDeltaThresholdPercent: number;
  intervalSeconds: number;
  bootstrapLookbackHours: number;
  nativeBackfillHours: number;
  maxStaleHours: number;
  sourceRetries: number;
  retryDelayMs: number;
  kibanaRequestTimeoutMs: number;
  metricsJson: boolean;
  quiet: boolean;
  dryRun: boolean;
  whitelistAll: boolean;
  maxPages: number;
  pageLimit: number;
  once: boolean;
  maxNativeGapFillCandles: number;
  staleTailThreshold: number;
  amaSlope: { lookbackBars: number; maxSlopePct: number; neutralZonePct: number; deltaThresholdPct: number };
  kalmanSlope: { maxSlopePct: number };
  atrPeriod: number;
  onTrigger?: Function;
}

export interface AmaSlopeSnapshot {
  slopePct: number;
  amaSlopeGated: number;
  rawSlopeOffset: number;
  maxSlopeOffset: number;
  slopeRatio: number;
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  direction: 1 | -1 | 0;
  smoothedSlopePct?: number;
  regimeMultiplier?: number;
  trendLabel?: string;
  amaSlopePercentMode?: string;
}

export interface DynamicWeightsPayload {
  isReady: boolean;
  effectiveWeights?: { sell: number; buy: number };
  meta?: {
    finalOffset?: number;
    slopeOffset?: number;
    maxSlopeOffset?: number;
    trend?: string;
    signalStrength?: number;
    atr?: number;
    volatilityPenalty?: number;
  };
  profile?: string;
}

export type Candle = [number, number, number, number, number, number];

export interface CenterSnapshotBotEntry {
  botName: string;
  gridCenterPrice: number;
  centerPrice: number;
  amaCenterPrice: number | null;
  lastGridResetAt: string | null;
  lastGridResetSource: string | null;
  lastAmaPrice: number | null;
  lastDeltaPercent: number | null;
  amaSlopeDeltaPercent: number | null;
  amaSlopeThresholdPercent: number | null;
  amaSlopePercentMode: string;
  gridRangeScalingAmaSlope: any;
  weights: any;
  effectiveWeights: any;
  collateralRecommendation: any;
  amaSlope: any;
  atr: any;
}

// ============================================================
// DOMAIN: PROCESSED FILL STORE
// ============================================================

export interface ProcessedFillStoreConfig {
  batchMs?: number;
  batchSize?: number;
  warn?: (msg: string) => void;
}

// ============================================================
// DOMAIN: DEXBot CLASS
// ============================================================
// ============================================================
// DOMAIN: ACCOUNT ORDERS (PERSISTENCE)
// ============================================================

export interface SerializedGridEntry {
  id: string | null;
  type: string | null;
  state: string | null;
  price: number;
  size: number;
  orderId: string;
}

export interface BotMeta {
  key: string;
  name: string | null;
  assetA: string | null;
  assetB: string | null;
  active: boolean;
  index: number | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// DOMAIN: GRACEFUL SHUTDOWN
// ============================================================

export interface CleanupHandler {
  name: string;
  handler: () => void | Promise<void>;
}

// ============================================================
// DOMAIN: CREDIT RUNTIME
// ============================================================
// ============================================================
// DOMAIN: NODE MANAGER
// ============================================================
// ============================================================
// DOMAIN: CHAIN KEYS CRYPTO
// ============================================================
// ============================================================
// DOMAIN: UTILITIES
// ============================================================
// ============================================================
// DOMAIN: AMA / KALMAN / SIGNALS
// ============================================================
