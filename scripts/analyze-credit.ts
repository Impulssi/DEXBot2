import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

'use strict';

/**
 * DEXBot Credit Analysis Script
 *
 * Live-chain overview of active MPA (margin / call-order) and credit
 * (borrowed deal) positions, summed per asset per bot — the credit
 * counterpart to `dexbot order` (scripts/analyze-orders.ts). Credit deals
 * additionally report per-pair and average CR, but only for pairs that are
 * both whitelisted in bots.json (debtPolicy.lending) and listed on the
 * current credit offer (acceptable_collateral) — anything else is reported
 * as ignored/unpriced and excluded from the average. A borrow-now preview
 * per configured pair shows the rate a fresh borrow would get today.
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
const { FEE_PARAMETERS } = require('../modules/constants');
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

// Credit CR math lives in modules/credit_pricing.ts (single source of truth,
// shared with the live credit runtime) — no local copies here.
import {
  averageCollateralRatio as averageCreditCr,
  creditDealCollateralRatio as creditDealCr,
  dailyOfferFeeRate,
  extractOfferConversionRate,
  normalizeCollateralMap as normalizeOfferCollateralMap,
} from '../modules/credit_pricing.js';

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
  async function fetchOfferObjects(offerIds: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    const unique = [...new Set(offerIds.filter(Boolean).map(String))];
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      try {
        const res = await dbCall('get_objects', [batch]);
        if (Array.isArray(res)) {
          for (const o of res) {
            if (o?.id) out.set(String(o.id), o);
          }
        }
      } catch { /* leave missing; deal falls back to pool/market pricing */ }
    }
    return out;
  }
  // Paginate to exhaustion (no page cap — books with >300 offers must not
  // silently lose pairs). MAX_OFFER_PAGES is only an infinite-loop guard
  // against a misbehaving node; the loop normally ends on a short page or
  // a repeated cursor.
  const MAX_OFFER_PAGES = 100;
  async function fetchLiveOffers(debtAssetId: string): Promise<any[]> {
    const out: any[] = [];
    const seen = new Set<string>();
    let start: string | null = null;
    for (let page = 0; page < MAX_OFFER_PAGES; page++) {
      const args = start == null ? [debtAssetId, 100] : [debtAssetId, 100, start];
      let rows: any;
      try {
        rows = await dbCall('get_credit_offers_by_asset', args);
      } catch { break; }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const o of rows) {
        if (o?.id && !seen.has(String(o.id))) {
          seen.add(String(o.id));
          out.push(o);
        }
      }
      if (rows.length < 100) break;
      const lastId = rows[rows.length - 1]?.id;
      if (typeof lastId !== 'string' || lastId === start) break;
      start = lastId;
    }
    return out;
  }
  // Wallet (free) balances per asset id, raw ints. Parsed from
  // get_full_accounts the same way chain_orders.getOnChainAssetBalances does.
  const walletCache = new Map<string, Map<string, number>>();
  async function fetchWalletRaw(account: string): Promise<Map<string, number>> {
    if (walletCache.has(account)) return walletCache.get(account)!;
    const out = new Map<string, number>();
    try {
      const res = await dbCall('get_full_accounts', [[account], false]);
      const entry = Array.isArray(res) && Array.isArray(res[0]) && res[0].length >= 2 ? res[0][1] : res?.[0];
      const balances = entry?.balances || [];
      for (const b of balances) {
        const aid = String(b?.asset_type || b?.asset_id || b?.asset || '');
        const raw = Number(b?.balance ?? b?.amount);
        if (aid && Number.isFinite(raw) && raw > 0) {
          out.set(aid, (out.get(aid) || 0) + raw);
        }
      }
    } catch { /* empty map; borrow-now shows N/A wallet */ }
    walletCache.set(account, out);
    return out;
  }
  const precisionOf = (assetId: string): number | null => {
    const info = assetCache.get(String(assetId));
    return info ? info.precision : null;
  };
  async function ensurePrecisions(assetIds: Iterable<string>): Promise<void> {
    for (const id of assetIds) {
      if (id && !assetCache.has(String(id))) {
        try { await assetInfo(String(id)); } catch { /* leave missing */ }
      }
    }
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
      const coll = new Map<string, { total: number; count: number; max: number }>();
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
              const e = coll.get(cId) || { total: 0, count: 0, max: 0 };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f); coll.set(cId, e);
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
              const e = coll.get(cId) || { total: 0, count: 0, max: 0 };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f); coll.set(cId, e);
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

    // ---- Credit CR: whitelisted pairs only ----
    // A deal counts towards the CR numbers only when its exact
    // debt←collateral pair is whitelisted in this bot's debtPolicy
    // (type creditOffer) AND the pair is listed on the current credit
    // offer (acceptable_collateral). Anything else is reported separately
    // as ignored/unpriced and excluded from the average CR.
    const lendingItems: any[] = hasLending(bot) && Array.isArray((bot as any).debtPolicy?.lending)
      ? (bot as any).debtPolicy.lending
      : [];
    // Configured credit pairs drive the whitelist, per-pair CR lines, and
    // the borrow-now preview.
    const creditPairs: Array<{ debtId: string | null; debtSym: string; collId: string | null; collSym: string; maxCR: number | null }> = [];
    for (const item of lendingItems) {
      if (!item || item.type !== 'creditOffer' || typeof item.asset !== 'string' || typeof item.collateralAsset !== 'string') continue;
      const [debtR, collR] = await Promise.all([
        resolveLendingRef(String(item.asset)),
        resolveLendingRef(String(item.collateralAsset)),
      ]);
      const maxCR = Number(item.maxCollateralRatio);
      creditPairs.push({
        debtId: debtR.id, debtSym: debtR.symbol,
        collId: collR.id, collSym: collR.symbol,
        maxCR: Number.isFinite(maxCR) && maxCR > 0 ? maxCR : null,
      });
    }
    const pairIdKeys = new Set(
      creditPairs.filter((p) => p.debtId && p.collId).map((p) => `${p.debtId}←${p.collId}`),
    );
    const pairSymKeys = new Set(
      creditPairs.map((p) => `${p.debtSym.toUpperCase()}←${p.collSym.toUpperCase()}`),
    );

    // Offer objects for the deals' conversion rates (debt per collateral).
    const dealOfferIds = creditDeals.map((d: any) => d?.offer_id).filter(Boolean).map(String);
    const offerById = await fetchOfferObjects(dealOfferIds);
    await ensurePrecisions((() => {
      const legIds = new Set<string>();
      for (const o of offerById.values()) {
        for (const price of normalizeOfferCollateralMap(o?.acceptable_collateral).values()) {
          if (price?.base?.asset_id) legIds.add(String(price.base.asset_id));
          if (price?.quote?.asset_id) legIds.add(String(price.quote.asset_id));
        }
      }
      return legIds;
    })());

    interface CrRow {
      dealId: string | null; debtId: string | null; debtSym: string; debtFloat: number | null;
      collId: string | null; collSym: string; collFloat: number | null;
      supported: boolean; rate: number | null; source: string | null;
      offerId: string | null; value: number | null; cr: number | null;
    }
    const crRows: CrRow[] = [];
    for (const d of creditDeals) {
      const debtId = typeof d?.debt_asset === 'string' ? d.debt_asset : null;
      const collId = typeof d?.collateral_asset === 'string' ? d.collateral_asset : null;
      const [debtFloat, collFloat] = await Promise.all([
        debtId ? toFloat(Number(d?.debt_amount), debtId) : null,
        collId ? toFloat(Number(d?.collateral_amount), collId) : null,
      ]);
      const debtSym = debtId ? await symbolOf(debtId) : '?';
      const collSym = collId ? await symbolOf(collId) : '?';
      let supported = false;
      if (debtId && collId && pairIdKeys.has(`${debtId}←${collId}`)) supported = true;
      else if (pairSymKeys.size > 0 && debtId && collId) {
        try {
          supported = pairSymKeys.has(`${(await symbolOf(debtId)).toUpperCase()}←${(await symbolOf(collId)).toUpperCase()}`);
        } catch { /* stays false */ }
      }
      // Conversion rate comes ONLY from the deal's current credit offer
      // (acceptable_collateral). A pair whose collateral is not listed on
      // the offer gets no CR — no pool/market estimates.
      let rate: number | null = null;
      let source: string | null = null;
      const offerId = d?.offer_id != null ? String(d.offer_id) : null;
      const offer = offerId ? offerById.get(offerId) : null;
      if (offer && collId && debtId) {
        const offerRate = extractOfferConversionRate(offer?.acceptable_collateral, collId, debtId, precisionOf);
        if (offerRate !== null) { rate = offerRate; source = 'offer'; }
      }
      const value = debtFloat != null && collFloat != null && rate !== null ? collFloat * rate : null;
      const cr = debtFloat != null && collFloat != null ? creditDealCr(debtFloat, collFloat, rate) : null;
      crRows.push({
        dealId: d?.id != null ? String(d.id) : null, debtId, debtSym, debtFloat,
        collId, collSym, collFloat, supported, rate, source, offerId, value, cr,
      });
    }
    const supportedRows = crRows.filter((r) => r.supported);
    const ignoredRows = crRows.filter((r) => !r.supported);
    const pricedSupported = supportedRows.filter((r) => r.cr !== null && r.value !== null && r.debtFloat !== null);
    const unpricedSupported = supportedRows.filter((r) => r.cr === null);
    const avgCr = averageCreditCr(pricedSupported.map((r) => ({ debt: r.debtFloat as number, value: r.value as number })));

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
      await printAssetLines('Credit coll', creditSum.coll, true, colors.buy);
      if (creditPairs.length > 0) console.log('');
      // Compact CR summary: one Curr. CR line per whitelisted pair, one
      // Avar. CR line per bot. A CR exists only for pairs both whitelisted
      // in bots.json and listed on the current credit offer.
      const feeDenom = Number(FEE_PARAMETERS?.GRAPHENE_FEE_RATE_DENOM) || 1000000;
      const walletRaw = await fetchWalletRaw(account);
      const matchPair = (pair: { debtId: string | null; debtSym: string; collId: string | null; collSym: string }, r: CrRow): boolean =>
        (pair.debtId !== null && r.debtId !== null && pair.debtId === r.debtId && pair.collId !== null && r.collId !== null && pair.collId === r.collId) ||
        (pair.debtSym.toUpperCase() === r.debtSym.toUpperCase() && pair.collSym.toUpperCase() === r.collSym.toUpperCase());
      for (const pair of creditPairs) {
        const pairRows = supportedRows.filter((r) => matchPair(pair, r));
        const pricedPair = pairRows.filter((r) => r.cr !== null && r.value !== null && r.debtFloat !== null);
        const pairDebt = pricedPair.reduce((s, r) => s + (r.debtFloat || 0), 0);
        const pairValue = pricedPair.reduce((s, r) => s + (r.value || 0), 0);
        const pairCr = pairDebt > 0 ? pairValue / pairDebt : null;
        const walletFloat = pair.collId && walletRaw.has(pair.collId)
          ? await toFloat(walletRaw.get(pair.collId)!, pair.collId)
          : null;
        // Current credit for the pair: active deal's offer first, else the
        // cheapest live offer listing the pair.
        let liveOffer: any = null;
        let liveRate: number | null = null;
        const offerRows = pairRows.filter((r) => r.source === 'offer' && r.rate !== null && r.offerId);
        if (offerRows.length > 0) {
          const ranked = offerRows.map((r) => ({ r, daily: dailyOfferFeeRate(offerById.get(r.offerId!), feeDenom) }))
            .sort((a, b) => a.daily - b.daily || String(a.r.offerId).localeCompare(String(b.r.offerId)));
          liveOffer = offerById.get(ranked[0].r.offerId!) || null;
          liveRate = ranked[0].r.rate;
        } else if (pair.debtId && pair.collId) {
          const liveOffers = (await fetchLiveOffers(pair.debtId)).filter((o) => o?.enabled !== false);
          const cands: Array<{ offer: any; rate: number; daily: number; id: string }> = [];
          for (const o of liveOffers) {
            await ensurePrecisions((() => {
              const ids = new Set<string>();
              for (const price of normalizeOfferCollateralMap(o?.acceptable_collateral).values()) {
                if (price?.base?.asset_id) ids.add(String(price.base.asset_id));
                if (price?.quote?.asset_id) ids.add(String(price.quote.asset_id));
              }
              return ids;
            })());
            const rate = extractOfferConversionRate(o?.acceptable_collateral, pair.collId, pair.debtId, precisionOf);
            if (rate !== null) cands.push({ offer: o, rate, daily: dailyOfferFeeRate(o, feeDenom), id: String(o.id) });
          }
          cands.sort((a, b) => a.daily - b.daily || a.id.localeCompare(b.id));
          if (cands.length > 0) { liveOffer = cands[0].offer; liveRate = cands[0].rate; }
        }
        const avail = liveOffer && pair.debtId
          ? await toFloat(Number(liveOffer.current_balance), pair.debtId)
          : null;
        // No active debt: borrow-now CR — wallet collateral value against
        // the offer's available funds, i.e. the CR a fresh borrow of the
        // full available amount would land at.
        let displayCr = pairCr;
        if (displayCr === null && walletFloat !== null && walletFloat > 0 && liveRate !== null && avail !== null && avail > 0) {
          displayCr = (walletFloat * liveRate) / avail;
        }
        // Green at/below the user max (borrow allowed), red above it, white
        // when no max is defined, gray when there is no CR at all.
        const crColor = displayCr === null
          ? colors.gray
          : pair.maxCR === null
            ? colors.white
            : displayCr > pair.maxCR ? colors.sell : colors.buy;
        const crText = displayCr !== null ? formatAmount(displayCr) : 'n/a';
        const availText = avail !== null && avail > 0
          ? `${formatAmount(avail)} ${pair.debtSym} avail.`
          : 'no funds avail.';
        console.log(`   ${colors.bold}Curr. CR:${colors.reset} ${crColor}${crText}${colors.reset} ${pair.debtSym}←${pair.collSym} | ${availText}`);
      }
      if (creditPairs.length > 0) console.log('');
      if (avgCr !== null) {
        // Color against the pairs' user max: single shared max → green/red,
        // mixed or undefined max → white (same rule as Current CR).
        const avgMaxSet = new Set<number>();
        for (const r of pricedSupported) {
          const pair = creditPairs.find((p) => matchPair(p, r));
          if (pair?.maxCR != null) avgMaxSet.add(pair.maxCR);
        }
        const avgMax = avgMaxSet.size === 1 ? [...avgMaxSet][0] : null;
        const avgColor = avgMax === null ? colors.white : avgCr > avgMax ? colors.sell : colors.buy;
        const pairTotals = new Map<string, { debtSym: string; collSym: string; debt: number; coll: number }>();
        for (const r of pricedSupported) {
          const key = `${r.debtSym}←${r.collSym}`;
          if (!pairTotals.has(key)) {
            pairTotals.set(key, { debtSym: r.debtSym, collSym: r.collSym, debt: 0, coll: 0 });
          }
          const t = pairTotals.get(key)!;
          t.debt += r.debtFloat || 0;
          t.coll += r.collFloat || 0;
        }
        const segments = [...pairTotals.values()]
          .map((t) => `${formatAmount(t.debt)} ${t.debtSym} ← ${formatAmount(t.coll)} ${t.collSym}`)
          .join(' + ');
        console.log(`   ${colors.bold}Avar. CR:${colors.reset} ${avgColor}${formatAmount(avgCr)}${colors.reset}, ${segments} ${colors.gray}(x${pricedSupported.length})${colors.reset}`);
      } else if (supportedRows.length > 0) {
        console.log(`   ${colors.bold}Avar. CR:${colors.reset} n/a (no priced, available credit)`);
      }
      // Split by reason so the runtime/analyzer asymmetry is visible:
      // "not whitelisted" never counts anywhere; "no offer price" is
      // whitelisted but absent from the current offer (the live runtime
      // still prices these via its pool/market fallback, the analyzer
      // deliberately does not).
      const ignored = ignoredRows.length;
      const unpriced = unpricedSupported.length;
      if (ignored + unpriced > 0) {
        const reasons: string[] = [];
        if (ignored > 0) reasons.push(`${ignored} not whitelisted`);
        if (unpriced > 0) reasons.push(`${unpriced} no offer price`);
        console.log(`   ${colors.gray}Excluded: ${ignored + unpriced} deal${ignored + unpriced === 1 ? '' : 's'} (${reasons.join(', ')})${colors.reset}`);
      }
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
