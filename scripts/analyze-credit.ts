import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

'use strict';

/**
 * DEXBot Credit Analysis Script
 *
 * Live-chain overview of active MPA (margin / call-order) and credit
 * (borrowed deal) positions, summed per asset per bot — the credit
 * counterpart to `dexbot order` (scripts/analyze-orders.ts).
 *
 * Chain source of truth (see bitshares-core):
 * - MPA positions:  database_api::get_margin_positions(account)
 *   (== get_call_orders_by_account(account, 1.3.0, api_limit_get_call_orders),
 *   libraries/app/database_api.cpp). call_order_object (chain/market_object.hpp):
 *   borrower, collateral (int, call_price.base.asset_id), debt (int,
 *   call_price.quote.asset_id), call_price { base, quote }.
 * - Credit deals:   database_api::get_credit_deals_by_borrower(account, ...)
 *   (libraries/app/database_api.cpp). credit_deal_object
 *   (chain/credit_offer_object.hpp): borrower, offer_id, offer_owner,
 *   debt_asset, debt_amount, collateral_asset, collateral_amount.
 *
 * Usage:
 *   node dist/scripts/analyze-credit.js            # credit-enabled bots only
 *   node dist/scripts/analyze-credit.js <bot>      # single bot (name or key)
 */

const { BitShares, waitForConnected, disconnectClient, setSuppressConnectionLog } = require('../modules/bitshares_client');
const { PATHS } = require('../modules/paths');
const { getErrorMessage } = require('../modules/utils/errors');
const { sanitizeKey } = require('../modules/utils/sanitize_key');
const { loadSettingsFile, resolveRawBotEntries, normalizeBotEntries } = require('../modules/bot_settings');
import { pathToFileURL } from 'node:url';
// Terminal colors: centralized palette (modules/cli_colors.ts), shared with
// `dexbot order` so both analyzers stay visually in lockstep.
import { CLI_COLORS as colors } from '../modules/cli_colors.js';

const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const CONNECT_TIMEOUT_MS = 30000;
const PAGE_LIMIT = 300;

// Chain connection chatter ([Transport] / [NodeManager] / [bitshares_client]
// status lines) would drown the overview, and the native loggers don't honor
// setSuppressConnectionLog — so drop their prefixed lines at the console
// level for the whole run. console.error stays untouched so real failures
// (thrown errors, per-bot fetch failures) still surface.
const _consoleLog = console.log.bind(console);
const _consoleInfo = console.info.bind(console);
const _consoleWarn = console.warn.bind(console);
const CHAIN_LOG_RE = /\[(Transport|NodeManager|bitshares_client)\]/;
function muteChainLogs() {
  const mute = (orig: (...args: any[]) => void) => (...args: any[]) => {
    if (args.length > 0 && typeof args[0] === 'string' && CHAIN_LOG_RE.test(args[0])) return;
    orig(...args);
  };
  console.log = mute(_consoleLog) as typeof console.log;
  console.info = mute(_consoleInfo) as typeof console.info;
  console.warn = mute(_consoleWarn) as typeof console.warn;
}

// Terminal colors — centralized palette (modules/cli_colors.ts), shared with
// `dexbot order` so both analyzers stay visually in lockstep.

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  let quotient = value;
  let suffix = '';
  if (abs >= 1_000_000) { quotient = value / 1_000_000; suffix = 'M'; }
  else if (abs >= 1000) { quotient = value / 1000; suffix = 'K'; }
  const absQ = Math.abs(quotient);
  const intDigits = Math.floor(Math.log10(Math.max(absQ, 1e-10))) + 1;
  let formatted: string;
  if (intDigits >= 4) formatted = String(Math.round(quotient));
  else {
    const dp = Math.max(0, 4 - intDigits);
    formatted = quotient.toFixed(dp).replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, '');
  }
  return formatted + suffix;
}

function hasLending(bot: any): boolean {
  return Boolean(bot && bot.debtPolicy && Array.isArray(bot.debtPolicy.lending) && bot.debtPolicy.lending.length > 0);
}

function lendingAssetsOfType(bot: any, type: string): string[] {
  if (!hasLending(bot)) return [];
  return (bot.debtPolicy.lending as any[])
    .filter((item: any) => item && item.type === type && typeof item.asset === 'string' && item.asset.length > 0)
    .map((item: any) => String(item.asset));
}

function allLendingAssets(bot: any): string[] {
  if (!hasLending(bot)) return [];
  return (bot.debtPolicy.lending as any[])
    .filter((item: any) => item && typeof item.asset === 'string' && item.asset.length > 0)
    .map((item: any) => String(item.asset));
}

async function dbCall(method: string, args: any[]): Promise<any> {
  if (BitShares?.db && typeof BitShares.db.call === 'function') {
    return BitShares.db.call(method, args);
  }
  throw new Error('BitShares DB client is unavailable');
}

async function fetchMarginPositions(account: string): Promise<any[]> {
  try {
    const res = await dbCall('get_margin_positions', [account]);
    if (Array.isArray(res)) return res;
  } catch (_) { /* fall through to paged variant */ }
  const res = await dbCall('get_call_orders_by_account', [account, '1.3.0', PAGE_LIMIT]);
  return Array.isArray(res) ? res : [];
}

async function fetchBorrowerDeals(account: string): Promise<any[]> {
  const all: any[] = [];
  let start: string | null = null;
  for (;;) {
    const args = start == null ? [account] : [account, PAGE_LIMIT, start];
    const page = await dbCall('get_credit_deals_by_borrower', args);
    if (!Array.isArray(page) || page.length === 0) break;
    // start_id is inclusive (>=) per database_api docs, so drop the overlap
    // row when paginating to avoid double-counting one deal.
    const rows = start != null && page[0]?.id === start ? page.slice(1) : page;
    if (rows.length === 0) break;
    all.push(...rows);
    if (page.length < PAGE_LIMIT) break;
    const lastId = page[page.length - 1]?.id;
    if (typeof lastId !== 'string' || lastId === start) break;
    start = lastId;
    if (all.length >= 5000) break;
  }
  return all;
}

function mpaDebtAssetId(order: any): string | null {
  const q = order?.call_price?.quote?.asset_id;
  if (typeof q === 'string' && q) return q;
  const d = order?.debt?.asset_id;
  if (typeof d === 'string' && d) return d;
  return null;
}

function mpaCollateralAssetId(order: any): string | null {
  const b = order?.call_price?.base?.asset_id;
  if (typeof b === 'string' && b) return b;
  const c = order?.collateral?.asset_id;
  if (typeof c === 'string' && c) return c;
  return null;
}

function mpaDebtRaw(order: any): number {
  const v = Number(order?.debt);
  if (Number.isFinite(v)) return v;
  const a = Number(order?.debt?.amount);
  return Number.isFinite(a) ? a : NaN;
}

function mpaCollateralRaw(order: any): number {
  const v = Number(order?.collateral);
  if (Number.isFinite(v)) return v;
  const a = Number(order?.collateral?.amount);
  return Number.isFinite(a) ? a : NaN;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('-h') || rawArgs.includes('--help')) {
    console.log('Usage: dexbot credit [<bot>]');
    console.log('  No args      Summed MPA + borrowed-credit positions for credit-enabled bots.');
    console.log('  <bot>        Only the named bot (matches name or sanitized key).');
    console.log('Live chain data via get_margin_positions + get_credit_deals_by_borrower per preferredAccount.');
    process.exit(0);
  }
  const botFilter = rawArgs.find((a) => !a.startsWith('-'))?.trim().toLowerCase() || null;

  const { config } = loadSettingsFile(BOTS_FILE);
  let bots = normalizeBotEntries(resolveRawBotEntries(config))
    .filter((b: any) => b && b.active !== false && hasLending(b));
  if (botFilter) {
    const sanitized = sanitizeKey(botFilter);
    const matched = bots.filter((b: any) =>
      String(b.name || '').toLowerCase() === botFilter ||
      sanitizeKey(String(b.name || '')) === sanitized ||
      String(b.botKey || '').toLowerCase() === botFilter);
    if (matched.length === 0) {
      console.log(`${colors.sell}No credit bot found for '${botFilter}'.${colors.reset}`);
      console.log('Available bots:');
      const all = normalizeBotEntries(resolveRawBotEntries(config));
      all.forEach((b: any) => console.log(`  - ${b.name}${hasLending(b) ? '' : ' (no debtPolicy)'}`));
      process.exit(0);
    }
    bots = matched;
  }
  if (bots.length === 0) {
    console.log(`No credit-enabled bots found in ${BOTS_FILE} (debtPolicy.lending is empty everywhere).`);
    process.exit(0);
  }

  const accountUsers = new Map<string, number>();
  for (const b of bots) {
    const acc = String(b.preferredAccount || '');
    if (acc) accountUsers.set(acc, (accountUsers.get(acc) || 0) + 1);
  }

  setSuppressConnectionLog(true);
  muteChainLogs();
  await waitForConnected(CONNECT_TIMEOUT_MS);
  // Asset metadata cache: id -> { symbol, precision }
  const assetCache = new Map<string, { symbol: string; precision: number }>();
  async function assetInfo(assetId: string): Promise<{ symbol: string; precision: number }> {
    if (assetCache.has(assetId)) return assetCache.get(assetId)!;
    const res = await dbCall('get_assets', [[assetId]]);
    const a = Array.isArray(res) ? res[0] : null;
    const info = { symbol: String(a?.symbol || assetId), precision: Number.isFinite(Number(a?.precision)) ? Number(a.precision) : 5 };
    assetCache.set(assetId, info);
    return info;
  }
  async function toFloat(raw: number, assetId: string): Promise<number | null> {
    if (!Number.isFinite(raw)) return null;
    const info = await assetInfo(assetId);
    return raw / Math.pow(10, info.precision);
  }
  async function symbolOf(assetId: string): Promise<string> {
    return (await assetInfo(assetId)).symbol;
  }
  async function resolveLendingRef(ref: string): Promise<{ id: string | null; symbol: string }> {
    const s = String(ref);
    if (/^1\.3\.\d+$/.test(s)) {
      try { return { id: s, symbol: await symbolOf(s) }; } catch { return { id: s, symbol: s }; }
    }
    try {
      const res = await dbCall('lookup_asset_symbols', [[s]]);
      const a = Array.isArray(res) ? res[0] : null;
      if (a?.id) {
        assetCache.set(String(a.id), { symbol: String(a.symbol || s), precision: Number(a.precision ?? 5) });
        return { id: String(a.id), symbol: String(a.symbol || s) };
      }
    } catch { /* keep raw symbol */ }
    return { id: null, symbol: s };
  }

  console.log(`\n${colors.cyan}💳 Credit Overview (live chain)${botFilter ? ` — filter: ${botFilter}` : ''}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(62)}${colors.reset}`);

  let totalMpa = 0;
  let totalDeals = 0;
  let analyzed = 0;

  for (const bot of bots) {
    const botName = String(bot.name || bot.botKey || 'unnamed');
    const account = String(bot.preferredAccount || '');
    if (!account) {
      console.log(`\n${colors.yellowBold}📊 ${botName}${colors.reset} ${colors.gray}(no preferredAccount — skipped)${colors.reset}`);
      continue;
    }
    const shared = (accountUsers.get(account) || 0) > 1;

    let callOrders: any[] = [];
    let deals: any[] = [];
    let fetchError: string | null = null;
    try {
      [callOrders, deals] = await Promise.all([fetchMarginPositions(account), fetchBorrowerDeals(account)]);
    } catch (err: any) {
      fetchError = getErrorMessage(err) || String(err);
    }
    if (fetchError) {
      console.log(`\n${colors.yellowBold}📊 ${botName}${colors.reset} ${colors.gray}(${account})${colors.reset}`);
      console.log(`   ${colors.sell}chain fetch failed: ${fetchError}${colors.reset}`);
      continue;
    }

    // Per-bot policy filter: chain positions are per-account, so when an
    // account is shared (or holds stray positions) only the debt assets in
    // this bot's debtPolicy count towards this bot's sums.
    const mpaRefs = lendingAssetsOfType(bot, 'mpa');
    const creditRefs = lendingAssetsOfType(bot, 'creditOffer');
    const unionRefs = allLendingAssets(bot);
    const mpaFilterRefs = mpaRefs.length > 0 ? mpaRefs : unionRefs;
    const creditFilterRefs = creditRefs.length > 0 ? creditRefs : unionRefs;
    const resolvedMpa = await Promise.all(mpaFilterRefs.map(resolveLendingRef));
    const resolvedCredit = await Promise.all(creditFilterRefs.map(resolveLendingRef));
    const mpaIds = new Set(resolvedMpa.map((r) => r.id).filter(Boolean) as string[]);
    const mpaSyms = new Set(resolvedMpa.map((r) => r.symbol.toUpperCase()));
    const creditIds = new Set(resolvedCredit.map((r) => r.id).filter(Boolean) as string[]);
    const creditSyms = new Set(resolvedCredit.map((r) => r.symbol.toUpperCase()));
    const filterActive = unionRefs.length > 0;

    async function debtMatches(debtAssetId: string | null, ids: Set<string>, syms: Set<string>): Promise<boolean> {
      if (!filterActive) return true;
      if (!debtAssetId) return false;
      if (ids.has(debtAssetId)) return true;
      try {
        const sym = (await symbolOf(debtAssetId)).toUpperCase();
        return syms.has(sym);
      } catch { return false; }
    }

    const mpaOrders: any[] = [];
    for (const o of callOrders) {
      if (await debtMatches(mpaDebtAssetId(o), mpaIds, mpaSyms)) mpaOrders.push(o);
    }
    const creditDeals: any[] = [];
    for (const d of deals) {
      const debtId = typeof d?.debt_asset === 'string' ? d.debt_asset : null;
      let symOk = false;
      if (!filterActive) symOk = true;
      else if (debtId && creditIds.has(debtId)) symOk = true;
      else if (debtId) {
        try { symOk = creditSyms.has((await symbolOf(debtId)).toUpperCase()); } catch { symOk = false; }
      }
      if (symOk) creditDeals.push(d);
    }

    // Sum per asset: debt totals keyed by debt asset, collateral totals keyed
    // by collateral asset. Debt entries also track the biggest single
    // position for the "(×N, ▲ …)" display.
    async function sumPositions(kind: 'mpa' | 'credit', items: any[]) {
      const debt = new Map<string, { total: number; count: number; max: number }>();
      const coll = new Map<string, { total: number; count: number }>();
      for (const it of items) {
        if (kind === 'mpa') {
          const dId = mpaDebtAssetId(it);
          const cId = mpaCollateralAssetId(it);
          const dRaw = mpaDebtRaw(it);
          const cRaw = mpaCollateralRaw(it);
          if (dId) {
            const f = await toFloat(dRaw, dId);
            if (f != null) {
              const e = debt.get(dId) || { total: 0, count: 0, max: 0 };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f); debt.set(dId, e);
            }
          }
          if (cId) {
            const f = await toFloat(cRaw, cId);
            if (f != null) {
              const e = coll.get(cId) || { total: 0, count: 0 };
              e.total += f; e.count += 1; coll.set(cId, e);
            }
          }
        } else {
          const dId = typeof it?.debt_asset === 'string' ? it.debt_asset : null;
          const cId = typeof it?.collateral_asset === 'string' ? it.collateral_asset : null;
          const dRaw = Number(it?.debt_amount);
          const cRaw = Number(it?.collateral_amount);
          if (dId && Number.isFinite(dRaw)) {
            const f = await toFloat(dRaw, dId);
            if (f != null) {
              const e = debt.get(dId) || { total: 0, count: 0, max: 0 };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f); debt.set(dId, e);
            }
          }
          if (cId && Number.isFinite(cRaw)) {
            const f = await toFloat(cRaw, cId);
            if (f != null) {
              const e = coll.get(cId) || { total: 0, count: 0 };
              e.total += f; e.count += 1; coll.set(cId, e);
            }
          }
        }
      }
      return { debt, coll };
    }

    const mpaSum = await sumPositions('mpa', mpaOrders);
    const creditSum = await sumPositions('credit', creditDeals);
    totalMpa += mpaOrders.length;
    totalDeals += creditDeals.length;
    analyzed++;

    async function fmtParts(m: Map<string, { total: number; count: number; max?: number }>, showBiggest = false): Promise<string[]> {
      if (m.size === 0) return [];
      const parts: string[] = [];
      for (const [id, e] of [...m.entries()].sort((a, b) => b[1].total - a[1].total)) {
        const sym = await symbolOf(id);
        const biggest = showBiggest && e.count > 1 && Number.isFinite(e.max) && (e.max as number) > 0
          ? `, ▲ ${formatAmount(e.max as number)}`
          : '';
        parts.push(`${formatAmount(e.total)} ${sym}${e.count > 1 ? ` ${colors.gray}(×${e.count}${biggest})${colors.reset}` : ''}`);
      }
      return parts;
    }

    // One asset per line; continuation lines align with the value column
    // (labels are all 11 chars wide, so `   <label>: ` is 16 chars).
    // Debt labels print red (money owed), collateral labels green (backing
    // locked) — same buy-green/sell-red semantics as `dexbot order`.
    async function printAssetLines(label: string, m: Map<string, { total: number; count: number; max?: number }>, showBiggest = false, labelColor: string = colors.yellowBold): Promise<void> {
      const plainPrefix = `   ${label}: `;
      const prefix = `   ${labelColor}${colors.bold}${label}:${colors.reset} `;
      const cont = ' '.repeat(plainPrefix.length);
      const parts = await fmtParts(m, showBiggest);
      parts.forEach((p, i) => {
        console.log(`${i === 0 ? prefix : cont}${p}`);
      });
    }

    console.log(`\n${colors.yellowBold}📊 ${botName}${colors.reset} ${colors.gray}(${account})${colors.reset}${shared ? ` ${colors.gray}[shared account]${colors.reset}` : ''}`);
    // Only list sections with active positions — empty sides stay hidden.
    if (mpaOrders.length > 0) {
      await printAssetLines('MPA    debt', mpaSum.debt, false, colors.sell);
      console.log('');
      await printAssetLines('MPA    coll', mpaSum.coll, false, colors.buy);
    }
    if (creditDeals.length > 0) {
      if (mpaOrders.length > 0) console.log('');
      await printAssetLines('Credit debt', creditSum.debt, true, colors.sell);
      console.log('');
      await printAssetLines('Credit coll', creditSum.coll, false, colors.buy);
    }
    if (mpaOrders.length === 0 && creditDeals.length === 0) {
      console.log(`   ${colors.gray}no active MPA/credit positions${colors.reset}`);
    }
  }

  console.log(`${colors.cyan}${'='.repeat(62)}${colors.reset}`);
  console.log(`${colors.cyan}Summary: ${analyzed} bots, ${totalMpa} MPA positions, ${totalDeals} credit deals${colors.reset}\n`);

  try { disconnectClient(); } catch { /* already disconnected */ }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: any) => {
    console.error(`credit: ${getErrorMessage(err) || err}`);
    try { disconnectClient(); } catch { /* noop */ }
    process.exit(1);
  });
}

export { formatAmount, hasLending };
