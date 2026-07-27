/**
 * market_adapter/index.ts — Barrel export for the market adapter subsystem.
 * Consumers import from this index instead of targeting internal file paths.
 *
 * CLI-only scripts (merge_lp_data, ama_signal_runner) are NOT exported here
 * since they are standalone entry points, not library modules.
 */

// ── Main adapter ───────────────────────────────────────────────────────────────

// ── Candle / interval utils ────────────────────────────────────────────────────

// ── Kibana / data sources ──────────────────────────────────────────────────────

// ── AMA & strategy core ────────────────────────────────────────────────────────

// ── Charting ────────────────────────────────────────────────────────────────────

// ── Utilities ───────────────────────────────────────────────────────────────────

// Note: test_helpers excluded — only consumed by test files referencing explicit paths.


import { MarketAdapterService } from './core/market_adapter_service';
import * as candleUtils from './candle_utils';
import * as intervalUtils from './interval_utils';
import * as kibanaClient from './core/kibana_client';
import * as kibanaMarketCandles from './core/kibana_market_candles';
import * as kibanaCandles from './core/kibana_candles';
import * as kibanaSource from './inputs/kibana_source';
import * as fetchLpData from './inputs/fetch_lp_data';
import * as ama from './core/strategies/ama';
import * as amaSlope from './core/strategies/ama_slope_model';
import * as regimeGate from './core/strategies/regime_gate';
import * as atrCalc from './core/strategies/atr/calculator';
import * as asymBounds from './core/asymmetric_bounds';
import * as configNormalizers from './core/config_normalizers';
import * as lpChartCore from './lp_chart_core';
import * as lpChartRunner from './lp_chart_runner';
import * as lpChartStrategyLoader from './lp_chart_strategy_loader';
import * as adapterClient from './utils/adapter_client';
import * as chainUtils from './utils/chain';
import * as nativeHistory from './utils/native_history';
import * as fileLock from './utils/file_lock';
import * as dataDiscovery from './utils/data_discovery';
import * as dynamicGridSnapshot from './utils/dynamic_grid_snapshot';
export { MarketAdapterService, candleUtils as candle_utils, intervalUtils as interval_utils, kibanaClient as kibana_client, kibanaMarketCandles as kibana_market_candles, kibanaCandles as kibana_candles, kibanaSource as kibana_source, fetchLpData as fetch_lp_data, ama, amaSlope as ama_slope_model, regimeGate as regime_gate, atrCalc as atr_calculator, asymBounds as asymmetric_bounds, configNormalizers as config_normalizers, lpChartCore as lp_chart_core, lpChartRunner as lp_chart_runner, lpChartStrategyLoader as lp_chart_strategy_loader, adapterClient as adapter_client, chainUtils as chain, nativeHistory as native_history, fileLock as file_lock, dataDiscovery as data_discovery, dynamicGridSnapshot as dynamic_grid_snapshot }

