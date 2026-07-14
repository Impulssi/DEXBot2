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
export type CowActionType = 'create' | 'cancel' | 'update';
export type AmaSlopePercentMode = 'perBar' | 'window';
export type ProcessedFillPersistenceMode = 'immediate' | 'batched' | 'manual';
export type CreditDealAutoRepay = 'no_auto_repayment' | 'only_full_repayment' | 'allow_partial_repayment';
export type GridPriceSource = 'pool' | 'book' | 'ama' | 'ama1' | 'ama2' | 'ama3' | 'ama4' | number | null;
export type StartPriceSource = 'pool' | 'book' | number;

/**
 * Blockchain operation type IDs matching the fc::static_variant index.
 * See graphene/protocol/operations.hpp for the canonical list:
 *   1  = limit_order_create
 *   2  = limit_order_cancel
 *   3  = call_order_update
 *   4  = fill_order (VIRTUAL)
 *   69 = credit_offer_create
 *   70 = credit_offer_delete
 *   71 = credit_offer_update
 *   72 = credit_offer_accept
 *   73 = credit_deal_repay
 *   74 = credit_deal_expired (VIRTUAL)
 *   77 = limit_order_update
 */
export type OperationTypeId =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32
  | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48
  | 49 | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57 | 58 | 59 | 60 | 61 | 62 | 63 | 64
  | 65 | 66 | 67 | 68 | 69 | 70 | 71 | 72 | 73 | 74 | 75 | 76 | 77;

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

/** Market parameters for margin positions (bitasset feeds). Matches graphene::protocol::price_feed */
export interface PriceFeed {
  settlement_price: Price;
  core_exchange_rate: Price;
  /** MCR (fixed point, denominator 1000) */
  maintenance_collateral_ratio: number;
  /** MSSR */
  maximum_short_squeeze_ratio: number;
}

// ============================================================
// BLOCKCHAIN ORDER STRUCTURES
// ============================================================

/** Raw limit order as returned by the blockchain API */
export interface ChainLimitOrder {
  id: string;
  seller: string;
  for_sale: number;
  sell_price: { base: Asset; quote: Asset };
  expiration: string;
  delegated_fee_asset_id?: string;
  created?: string;
}

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

export interface CreditOfferCreateOp {
  fee: Asset;
  owner_account: string;
  asset_type: string;
  balance: number;
  fee_rate: number;
  max_duration_seconds: number;
  min_deal_amount: number;
  enabled: boolean;
  auto_disable_time: number;
  acceptable_collateral: Record<string, Price>;
  acceptable_borrowers: Record<string, number>;
  extensions?: Record<string, any>;
}

export interface CreditOfferAcceptOp {
  fee: Asset;
  borrower: string;
  offer_id: string;
  borrow_amount: Asset;
  collateral: Asset;
  max_fee_rate: number;
  min_duration_seconds: number;
  extensions?: Record<string, any>;
}

export interface CreditDealRepayOp {
  fee: Asset;
  account: string;
  deal_id: string;
  repay_amount: Asset;
  credit_fee: Asset;
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

export interface CreateOrderResult {
  success?: boolean;
  dryRun?: boolean;
  params?: Record<string, any>;
  skipped?: boolean;
  raw?: any;
  operation_results?: any[];
}

export interface CancelOrderResult {
  success: boolean;
  orderId: string;
  verified: boolean;
  verifiedAfterFailure?: boolean;
  raw?: any;
  operation_results?: any[];
}

export interface BatchExecutionResult {
  success: boolean;
  raw: any;
  operation_results: any[];
}

export interface DaemonExecutionResult {
  success: boolean;
  raw: any | null;
  operation_results: any[];
}

export interface OnChainBalances {
  assetId: string;
  symbol: string;
  precision: number;
  freeRaw: number;
  lockedRaw: number;
  free: number;
  locked: number;
  total: number;
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
  isDustRefill?: boolean;
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

export interface FilledOrder extends OrderBase {
  state: 'filled';
  orderId: string;
  size: number;
  blockNum: number;
  historyId: string;
  isMaker: boolean;
  isPartial?: boolean;
  filledSize?: number;
  isDelayedRotationTrigger?: boolean;
}

export interface FilledPortion {
  size: number;
  isPartial: true;
  blockNum: number;
  historyId: string;
  isMaker: boolean;
}

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

export interface GridPricingContext {
  gridPrice: number;
  gridPriceOffsetPct: number;
  offsetAdjustedStartPrice: number;
  startPrice: number;
  configuredMinPrice: number | string;
  configuredMaxPrice: number | string;
  rangeScalingFactor: number | null;
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

export interface BotFunds {
  chainFree: SideFunds;
  allocated: SideFunds;
  committed: SideFunds;
  virtual: SideFunds;
  btsFeesOwed: number;
}

export interface AccountTotals {
  buy: number | null;
  sell: number | null;
  buyFree: number | null;
  sellFree: number | null;
}

export interface BalanceAdjustment {
  orderType: 'buy' | 'sell';
  delta: number;
  operation: string;
}

export interface TargetGridValidation {
  isValid: boolean;
  shortfall: { buy: number; sell: number };
  details: { requiredBuy: number; requiredSell: number; totalBuy: number; totalSell: number };
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

export interface DeltaAction {
  type: 'create' | 'cancel' | 'update';
  id: string;
  order?: Order;
  orderId?: string;
  prevOrder?: Order;
}

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

export interface CommitEvalResult {
  canCommit: boolean;
  reason?: string;
  level?: 'error' | 'warn' | 'debug';
}

export interface DriftCheckResult {
  isValid: boolean;
  driftBuy: number;
  driftSell: number;
  allowedDriftBuy: number;
  allowedDriftSell: number;
  reason: string | null;
}

export interface FundValidationResult {
  isValid: boolean;
  reason: string | null;
  shortfalls: Array<{ asset: string; required: number; available: number; deficit: number }>;
  required: { buyInt: number; sellInt: number; buy: number; sell: number };
  available: { buy: number; sell: number };
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

export interface MemoryStats {
  size: number;
  modified: number;
  estimatedBytes: number;
}

export interface IndexValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================
// DOMAIN: STRATEGY / TARGET GRID
// ============================================================

export interface TargetGridEntry {
  id: string;
  price: number;
  type: OrderType;
  size: number;
  idealSize: number;
  state: OrderState;
  committedSide?: OrderType;
}

// ============================================================
// DOMAIN: SYNC ENGINE
// ============================================================

export interface SyncResult {
  filledOrders: Order[];
  updatedOrders: Order[];
  ordersNeedingCorrection: PriceCorrectionEntry[];
}

export interface FillHistoryResult {
  filledOrders: Order[];
  updatedOrders: Order[];
  partialFill: boolean;
  requiresOpenOrdersSync?: boolean;
}

export interface SynchronizeResult {
  newOrders: Order[];
  ordersNeedingCorrection: PriceCorrectionEntry[];
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

export interface ChainCreateOrderData {
  gridOrderId: string;
  chainOrderId: string;
  isPartialPlacement: boolean;
  expectedType?: string;
  fee: number;
  skipAccounting?: boolean;
}

export interface ChainCancelOrderData {
  orderId: string;
  clearSize?: boolean;
}

// ============================================================
// DOMAIN: STATE MANAGER / PIPELINE
// ============================================================

export interface SignalEntry {
  id: string;
  context: string;
  message: string;
  at: number;
}

export interface AccountingFailureSignal {
  code: 'ACCOUNTING_COMMITMENT_FAILED';
  side: 'buy' | 'sell';
  amount: number;
  context: string;
  at: number;
}

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

export interface StateManagerState {
  rebalance: PipelineState;
  recovery: RecoveryState;
  gridRegen: { buy: GridRegenSideState; sell: GridRegenSideState };
  bootstrap: { isBootstrapping: boolean };
  broadcast: { isBroadcasting: boolean };
  signals: { lastIllegalState: SignalEntry | null; lastAccountingFailure: AccountingFailureSignal | null };
  pipeline: { blockedSince: number | null; recoveryAttempted: boolean };
}

export interface Metrics {
  fundRecalcCount: number;
  invariantViolations: { buy: number; sell: number };
  lockAcquisitions: number;
  lockContentionSkips: number;
  spreadRoleConversionBlocked: number;
  lastSyncDurationMs: number;
  metricsStartTime: number;
  state: StateManagerState;
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

export interface PipelineSignals {
  incomingFillQueueLength?: number;
  shadowLocks?: number;
  batchInFlight?: boolean;
  recoveryInFlight?: boolean;
  broadcasting?: boolean;
}

export interface OrderUpdateOptions {
  skipAccounting?: boolean;
  fee?: number;
}

export interface CommitOptions {
  skipRecalc?: boolean;
}

export interface CowComparePrecisions {
  buyPrecision: number;
  sellPrecision: number;
  priceRelativeTolerance: number;
}

// ============================================================
// DOMAIN: STARTUP RECONCILE
// ============================================================

export interface StartupGridAction {
  shouldRegenerate: boolean;
  hasActiveMatch: boolean;
  resumedByPrice: boolean;
  matchedCount: number;
}

export interface PriceMatchResumeResult {
  resumed: boolean;
  matchedCount: number;
}

export interface StartupReconcileSideResult {
  chainCount: number;
}

export interface StartupUpdateBatchResult {
  executed: boolean;
  prepared: number;
  skipped: boolean;
}

export interface StartupSequentialUpdateResult {
  executed: number;
  skipped: number;
  failed: number;
}

// ============================================================
// DOMAIN: FILL PROCESSING / RUNTIME
// ============================================================

export interface ReplaySafeFillResult {
  status: 'applied' | 'duplicate' | 'missing_key' | 'error';
  fillKey: string | null;
  usedFallbackKey?: boolean;
  error?: Error;
}

export interface SyntheticFill {
  isPartial: boolean;
  isDelayedRotationTrigger?: boolean;
  dustCancelTriggeredAt?: number;
  dustRecoveredFromChain?: boolean;
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

export interface DustCancelResult {
  cancelledCount: number;
  batchResult: { abortedForIllegalState: boolean; abortedForAccountingFailure: boolean } | null;
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
  dustCancelDelaySec?: number;
  fundInvariantPercentTolerance?: number;
  minSpreadOrders?: number;
  gridComparison?: { rmsPercentage?: number };
  priceDriftToleranceMultiplier?: number;
  relativeOrderUpdateThresholdPercent?: number;
  stateChangeHistoryMax?: number;
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
  debtPolicy?: DebtPolicy;
  logging?: BotLoggingOverrides;
  gridLimits?: BotGridLimitsOverrides;
  feeParams?: BotFeeParamsOverrides;
  timing?: BotTimingOverrides;
  incrementBounds?: BotIncrementBoundsOverrides;
}

export interface DEXBotConfig extends BotConfigEntry {
  botKey: string;
  botIndex?: number;
  ama?: BotAmaConfig;
  marketAdapterSettings?: Record<string, any>;
  TIMING?: Record<string, any>;
  min_BTS_value?: number;
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

export interface BotsFile {
  bots: BotConfigEntry[];
}

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

export interface GeneralSettings {
  LOG_LEVEL?: string;
  GRID_LIMITS?: Record<string, any>;
  TIMING?: Record<string, any>;
  UPDATER?: Record<string, any>;
  MARKET_ADAPTER?: Record<string, any>;
  LOGGING_CONFIG?: LoggingConfig;
  NATIVE_CLIENT?: Record<string, any>;
  FILL_PROCESSING?: Record<string, any>;
  PIPELINE_TIMING?: Record<string, any>;
  DEFAULT_CONFIG?: Record<string, any>;
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

export interface SessionSecret {
  kind: 'dexbot-session-secret';
  version: number;
  sessionSaltHex: string;
  vaultKeyHex: string;
}

export interface DaemonSigningToken {
  kind: 'dexbot-daemon-signing-token';
  accountName: string;
  socketPath: string;
  sessionId: string | null;
  botHmacSecret: string | null;
}

export interface KeyValidationResult {
  valid: boolean;
  reason?: string;
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

export interface GridPriceOffsetPlan {
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  rawSlopeOffset: number | null;
  maxSlopeOffset: number | null;
  slopeRatio: number;
  targetSpreadPercent: number;
  maxGridPriceOffsetPct: number;
  gridPriceOffsetPct: number;
}

export interface BotState {
  botName: string;
  botKey: string;
  marketSource: 'pool' | 'book' | null;
  priceMode: 'book' | 'fixed' | null;
  lastCycleSource: string | null;
  lastCycleAt: string | null;
  pendingClosedCandle: boolean;
  lastTriggerSuppressedReason: string | null;
  poolId: string | null;
  candleFile: string | null;
  candleCount: number;
  analysisCandleCount: number;
  kibanaGapRepairCount: number;
  kibanaBackfillCount: number;
  unresolvedGapCount: number;
  nativeRecentTradeSequences: number[];
  nativeLastTradeTs: number | null;
  nativeOverlapCount: number | null;
  nativePagesFetched: number | null;
  lastCandleTs: number | null;
  rawLastCandleTs: number | null;
  lastClosedCandleTs: number | null;
  gridCenterPrice: number | null;
  centerPrice: number | null;
  amaCenterPrice: number | null;
  amaConfig: { erPeriod: number; fastPeriod: number; slowPeriod: number; erSmoothPeriod: number } | null;
  atr: number | null;
  weightVariance: number | null;
  weights: DynamicWeightsPayload | null;
  effectiveWeights: { sell: number; buy: number } | null;
  collateralRecommendation: any;
  amaSlope: AmaSlopeSnapshot | null;
  amaSlopeDeltaPercent: number | null;
  amaSlopeThresholdPercent: number | null;
  rawKeepCount: number;
  analysisKeepCount: number;
  amaWarmupBars: number;
  staleData: boolean;
  staleAgeHours: number | null;
  dynamicWeightWhitelisted?: boolean;
  gridRangeScalingWhitelisted?: boolean;
  dynamicWeightReady?: boolean;
  dynamicWeightProfile?: string | null;
  dynamicWeightApplied?: boolean;
  hasExplicitBaseWeights?: boolean;
}

export interface ProcessBotResult {
  ok: boolean;
  dryRunMessages: string[];
  source: string;
  marketSource: 'pool' | 'book';
  intervalSeconds: number;
  candleCount: number;
  analysisCandleCount: number;
  rawKeepCount: number;
  analysisKeepCount: number;
  amaWarmupBars: number;
  kibanaGapRepairCount: number;
  kibanaBackfillCount: number;
  unresolvedGapCount: number;
  nativeRecentTradeSequences: number[];
  nativeLastTradeTs: number | null;
  nativeOverlapCount: number | null;
  nativePagesFetched: number | null;
  amaPrice: number | null;
  previousCenterPrice: number | null;
  deltaPercent: number | null;
  thresholdPercent: number | null;
  referencePrice: number | null;
  amaComparison: any[];
  triggered: boolean;
  triggerPath: string | null;
  staleData: boolean;
  staleAgeHours: number | null;
  triggerCallbackError: string | null;
  triggerSuppressedReason: string | null;
  weights: DynamicWeightsPayload | null;
  collateralRecommendation: any;
  amaSlope: AmaSlopeSnapshot | null;
  amaSlopeDeltaPercent: number | null;
  amaSlopeThresholdPercent: number | null;
  dynamicWeightWhitelisted: boolean;
  gridRangeScalingWhitelisted: boolean;
  dynamicWeightReady: boolean;
  dynamicWeightProfile: string | null;
  dynamicWeightApplied: boolean;
  hasExplicitBaseWeights: boolean;
  poolId: string | null;
  candleFile: string;
  lastCandleTs: number | null;
  rawLastCandleTs: number | null;
  lastClosedCandleTs: number | null;
  lastClosedCandleClose: number;
  centerPrice: number;
  amaConfig: { erPeriod: number; fastPeriod: number; slowPeriod: number; erSmoothPeriod: number };
  atr: number | null;
  weightVariance: number | null;
  pendingClosedCandle: boolean;
  reason?: string;
}

export type Candle = [number, number, number, number, number, number];

export interface TriggerFilePayload {
  createdAt: string;
  source: string;
  botName: string;
  botKey: string;
  price?: number;
  amaPrice?: number;
  previousCenterPrice?: number;
  deltaPercent?: number;
  thresholdPercent?: number;
  dynamicGridPath?: string;
}

export interface DynamicGridSnapshot {
  gridCenterPrice: number;
  centerPrice: number;
  amaCenterPrice: number;
  amaSlopePercentMode: 'perBar';
  updatedAt: string;
  source: string;
  amaSlope?: AmaSlopeSnapshot;
  gridRangeScalingAmaSlope?: AmaSlopeSnapshot;
  gridPriceOffsetPct?: number;
  amaSlopeDeltaPercent?: number;
  amaSlopeThresholdPercent?: number;
  dynamicWeights?: DynamicWeightsPayload;
  lastGridResetAt?: string;
  lastGridResetSource?: string;
}

export interface CenterSnapshot {
  updatedAt: string;
  bots: Record<string, CenterSnapshotBotEntry>;
}

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

export interface DEXBotMetrics {
  fillsProcessed: number;
  fillProcessingTimeMs: number;
  batchesExecuted: number;
  lockContentionEvents: number;
  maxQueueDepth: number;
}

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

export interface PerBotStorage {
  meta: BotMeta;
  grid: SerializedGridEntry[];
  btsFeesOwed: number;
  boundaryIdx: number | null;
  assets: AssetsPair | null;
  debugInputs: Record<string, any> | null;
  processedFills: Record<string, number>;
  createdAt: string;
  lastUpdated: string;
}

export interface DBAssetBalances {
  assetA: { active: number; virtual: number };
  assetB: { active: number; virtual: number };
  meta: { key: string; name: string | null; assetA: string | null; assetB: string | null };
}

// ============================================================
// DOMAIN: GRACEFUL SHUTDOWN
// ============================================================

export interface CleanupHandler {
  name: string;
  handler: () => void | Promise<void>;
}

export interface ShutdownState {
  cleanupHandlers: CleanupHandler[];
  shutdownInProgress: boolean;
}

// ============================================================
// DOMAIN: CREDIT RUNTIME
// ============================================================

export interface CreditDeal {
  id: string;
  offer_id: string;
  borrower: string;
  borrow_amount: Asset;
  collateral: Asset;
  fee_rate: number;
  expiration: number;
  auto_repay: number;
}

export interface CreditOffer {
  id: string;
  owner_account: string;
  asset_type: string;
  balance: number;
  fee_rate: number;
  max_duration_seconds: number;
  min_deal_amount: number;
  enabled: boolean;
  auto_disable_time: number;
  acceptable_collateral: Record<string, Price>;
  acceptable_borrowers: Record<string, number>;
}

// ============================================================
// DOMAIN: NODE MANAGER
// ============================================================

export interface NodeHealth {
  url: string;
  connected: boolean;
  latency: number;
  lastChecked: number;
  failCount: number;
  blacklistedUntil?: number;
}

// ============================================================
// DOMAIN: CHAIN KEYS CRYPTO
// ============================================================

export interface DaemonRequest {
  type: 'ping' | 'probe-account' | 'broadcast-operation' | 'execute-operations';
  accountName: string;
}

export interface DaemonProbeResponse {
  success: boolean;
  sessionId?: string;
  error?: string;
}

// ============================================================
// DOMAIN: UTILITIES
// ============================================================

export interface CreateOrderArgs {
  amountToSell: number;
  sellAssetId: string;
  minToReceive: number;
  receiveAssetId: string;
}

export interface OrderComparisonOptions {
  precisions?: {
    buyPrecision?: number | string | null;
    sellPrecision?: number | string | null;
    defaultPrecision?: number | string | null;
    priceRelativeTolerance?: number;
  };
}

export interface OutsideInPairGroupAccessors {
  isValid?: (order: Order) => boolean;
  getType: (order: Order) => OrderType;
  getPrice: (order: Order) => number;
}

// ============================================================
// DOMAIN: AMA / KALMAN / SIGNALS
// ============================================================

export interface AmaPreset {
  name: string;
  erPeriod: number;
  fastPeriod: number;
  slowPeriod: number;
}

export interface MarketAdapterRuntimeDefaults {
  intervalSeconds: number;
  intervalLabel: string;
  pollSeconds: number;
  bootstrapLookbackHours: number;
  nativeBackfillHours: number;
  maxStaleHours: number;
  sourceRetries: number;
  retryDelayMs: number;
  maxPages: number;
  pageLimit: number;
  minRequiredCandles: number;
}
