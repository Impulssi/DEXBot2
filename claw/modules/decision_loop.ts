'use strict';
/**
 * Decision Loop
 *
 * Core cycle that ties position discovery, health assessment, and trend
 * detection into an actionable evaluation. Runs on a schedule or on demand.
 *
 * Flow:
 *   1. Discover on-chain positions (position_discovery)
 *   2. Fetch trend input per market (feed_price_source)
 *   3. Update trend analyzer per market (kalman_trend_analyzer)
 *   4. Assess each position's health (position_health)
 *   5. Return assessments with prioritized actions
 *
 * This module evaluates and recommends — it does NOT execute trades.
 * Execution is a separate concern.
 */


import { discoverPositions } from './position_discovery.js';
import { assessPosition } from './position_health.js';
import { fetchTrendInput } from './feed_price_source.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
// Static import (previously a lazy createRequire fallback): lazy require()
// bypasses the ESM loader hooks that compiled tests use for module mocking,
// and the analyzer module carries no circular-import risk.
import { KalmanTrendAnalyzer } from '../../market_adapter/core/signals/kalman_trend_analyzer.js';


function getTrendAnalyzer() {
  return KalmanTrendAnalyzer;
}

/**
 * Per-market trend analyzer instances, keyed by MPA symbol.
 * Persists across loop iterations so Kalman filter state accumulates.
 */
const analyzers = new Map();
const analyzerConfigs = new Map();
// Cached premium per market so the same-market reuse path reports the same
// premium that the fresh path computed instead of a null placeholder.
const marketPremiums = new Map();

function configChanged(mpaSymbol: string, config: Record<string, any>) {
  const prev = analyzerConfigs.get(mpaSymbol);
  if (!prev) return true;
  return JSON.stringify(prev) !== JSON.stringify(config);
}

function getOrCreateAnalyzer(mpaSymbol: string, config: Record<string, any> = {}) {
  if (!analyzers.has(mpaSymbol) || configChanged(mpaSymbol, config)) {
    const TA = getTrendAnalyzer();
    analyzers.set(mpaSymbol, new TA(config));
    analyzerConfigs.set(mpaSymbol, JSON.parse(JSON.stringify(config)));
  }
  return analyzers.get(mpaSymbol);
}

/**
 * Run one evaluation cycle for all positions on an account.
 *
 * @param {string} accountName – BitShares account name
 * @param {Object} [options]
 * @param {Object} [options.analyzerConfig] – TrendAnalyzer config overrides
 * @param {Object|Function} [options.logger]       – Console-like logger with .info/.warn/.error (default console)
 * @returns {Object} { account, evaluatedAt, positionCount, positions: [...assessments], summary }
 */
async function evaluate(accountName: string, options: Record<string, any> = {}) {
  const logger = options.logger 
    ? (typeof options.logger.info === 'function' ? options.logger : { info: options.logger, warn: options.logger, error: options.logger })
    : console;
  const analyzerConfig = options.analyzerConfig || {};

  // 1. Discover positions
  const positions = await discoverPositions(accountName);
  if (positions.length === 0) {
    return {
      account: accountName,
      evaluatedAt: new Date().toISOString(),
      positionCount: 0,
      positions: [],
      summary: buildSummary([]),
    };
  }

  // 2–4. For each position: fetch trend, update analyzer, assess health
  const assessments: Array<Record<string, any>> = [];
  const marketsSeen = new Set<string>();

  for (const position of positions) {
    const mpa = position.mpaSymbol;
    let trendSignal = null;

    // Fetch trend data once per market
    if (!marketsSeen.has(mpa)) {
      marketsSeen.add(mpa);
      try {
        const trendInput = await fetchTrendInput(mpa);
        if (trendInput.marketPrice != null && trendInput.feedPrice != null) {
          const analyzer = getOrCreateAnalyzer(mpa, analyzerConfig);
          // KalmanTrendAnalyzer.update accepts a single price series; the feed
          // price is tracked separately (and surfaced via premium below).
          const result = analyzer.update(trendInput.marketPrice);
          marketPremiums.set(mpa, trendInput.premium);
          trendSignal = {
            trend: result.trend,
            confidence: result.confidence,
            premium: trendInput.premium,
          };
        }
      } catch (err: any) {
        logger.info(`[decision_loop] trend fetch failed for ${mpa}: ${getErrorMessage(err)}`);
      }
    } else {
      // Reuse last trend signal for same market
      const analyzer = analyzers.get(mpa);
      if (analyzer) {
        const snapshot = analyzer.getAnalysis();
        trendSignal = {
          trend: snapshot.trend,
          confidence: snapshot.confidence,
          // TrendAnalysis has no premium field; reuse the cached market premium.
          premium: marketPremiums.get(mpa) ?? null,
        };
      }
    }

    // Assess health
    const assessment = assessPosition(position, trendSignal);
    assessment.market = position.market;
    assessment.mpaSymbol = mpa;
    assessment.onChain = position.onChain;
    assessments.push(assessment);
  }

  // 5. Sort by action priority: immediate first, then soon, then evaluate
  const priorityOrder = { immediate: 0, soon: 1, evaluate: 2, fallback: 3 };
  assessments.sort((a: any, b: any) => {
    const aPriority: string = a.actions[0]?.priority || 'fallback';
    const bPriority: string = b.actions[0]?.priority || 'fallback';
    return (priorityOrder[aPriority as keyof typeof priorityOrder] ?? 99) - (priorityOrder[bPriority as keyof typeof priorityOrder] ?? 99);
  });

  return {
    account: accountName,
    evaluatedAt: new Date().toISOString(),
    positionCount: assessments.length,
    positions: assessments,
    summary: buildSummary(assessments),
  };
}

/**
 * Build a quick summary of the evaluation results.
 */
function buildSummary(assessments: Array<Record<string, any>>) {
  const zones: Record<string, number> = { red_low: 0, green: 0, red_high: 0, unknown: 0 };
  let immediateActions = 0;
  let soonActions = 0;

  for (const a of assessments) {
    const zone: string = a.collateral?.zone || 'unknown';
    zones[zone] = (zones[zone] || 0) + 1;

    for (const action of a.actions as Array<Record<string, any>>) {
      if (action.priority === 'immediate') immediateActions++;
      if (action.priority === 'soon') soonActions++;
    }
  }

  return {
    zones,
    immediateActions,
    soonActions,
    allGreen: zones.green === assessments.length,
  };
}

/**
 * Reset all cached trend analyzers. Useful for testing or config changes.
 */
function resetAnalyzers() {
  analyzers.clear();
  analyzerConfigs.clear();
  // Premiums belong to the analyzer generation that produced them; keeping
  // them across a reset would let the reuse path report a stale value from
  // discarded config.
  marketPremiums.clear();
}

export { evaluate, getOrCreateAnalyzer, resetAnalyzers }

