#!/usr/bin/env node

/**
 * Diagnostic Script: BTS/XBTSX.XAUT Market Book Fetch
 *
 * Tests order book, ticker, LP pool, and market history for this
 * low-volume market to verify DEXBot2 price source handling.
 */

if (process.env.RUN_LIVE_BITSHARES_TESTS !== '1') {
    console.log('Skipping live BitShares connection test.');
    console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
    process.exit(0);
}

const { BitShares, waitForConnected } = require('../modules/bitshares_client');
const Format = require('../modules/order/format');
const { getErrorMessage } = require('../modules/utils/errors');

const C = {
    reset: '\x1b[0m',
    green: '\x1b[92m',
    blue: '\x1b[96m',
    yellow: '\x1b[93m',
    red: '\x1b[38;5;160m',
    bold: '\x1b[1m',
};

async function lookup(symbol) {
    const res = await BitShares.db.lookup_asset_symbols([symbol]);
    return res[0];
}

async function main() {
    try {
        console.log(`${C.bold}${C.blue}=== BTS/XBTSX.XAUT Market Diagnostics ===${C.reset}\n`);

        console.log(`${C.yellow}Connecting to BitShares...${C.reset}`);
        await waitForConnected(15000);

        let ready = false;
        for (let i = 0; i < 30 && !ready; i++) {
            try {
                await BitShares.db.lookup_asset_symbols(['BTS']);
                ready = true;
            } catch {
                await new Promise(r => setTimeout(r, 500));
            }
        }
        console.log(`${C.green}✓ Connected and synced${C.reset}\n`);

        // ------------------------------------------------------------------
        // 1. Asset info
        // ------------------------------------------------------------------
        console.log(`${C.bold}── Asset Info ──${C.reset}`);
        const btsAsset = await lookup('BTS');
        const xautAsset = await lookup('XBTSX.XAUT');

        if (!btsAsset) { console.log(`${C.red}✗ BTS not found${C.reset}`); process.exit(1); }
        if (!xautAsset) { console.log(`${C.red}✗ XBTSX.XAUT not found${C.reset}`); process.exit(1); }

        console.log(`  BTS:        id=${btsAsset.id}, precision=${btsAsset.precision}, symbol=${btsAsset.symbol}`);
        console.log(`  XBTSX.XAUT: id=${xautAsset.id}, precision=${xautAsset.precision}, symbol=${xautAsset.symbol}`);

        // Check if XBTSX.XAUT is an MPA (has bitasset_data_id)
        const isMpa = !!xautAsset.bitasset_data_id;
        console.log(`  XBTSX.XAUT is MPA: ${isMpa}`);
        if (isMpa) {
            console.log(`  bitasset_data_id: ${xautAsset.bitasset_data_id}`);
        }
        console.log();

        // ------------------------------------------------------------------
        // 2. Order book — BTS base, XBTSX.XAUT quote (native orientation)
        // ------------------------------------------------------------------
        console.log(`${C.bold}── Order Book: BTS (base) / XBTSX.XAUT (quote) ──${C.reset}`);
        console.log(`  get_order_book(${btsAsset.id}, ${xautAsset.id}, 10)`);
        let ob1;
        try {
            ob1 = await BitShares.db.get_order_book(btsAsset.id, xautAsset.id, 10);
            console.log(`  Bids: ${ob1.bids?.length ?? 0}`);
            if (ob1.bids?.length) {
            ob1.bids.forEach((b, i) => console.log(`    ${i+1}. price=${Format.formatPrice(Number(b.price))}  base=${b.base}  quote=${b.quote}`));
        }
        console.log(`  Asks: ${ob1.asks?.length ?? 0}`);
        if (ob1.asks?.length) {
            ob1.asks.forEach((a, i) => console.log(`    ${i+1}. price=${Format.formatPrice(Number(a.price))}  base=${a.base}  quote=${a.quote}`));
            }
        } catch (e) {
            console.log(`${C.red}  Error: ${getErrorMessage(e)}${C.reset}`);
        }
        console.log();

        // ------------------------------------------------------------------
        // 3. Order book — XBTSX.XAUT base, BTS quote (reversed)
        // ------------------------------------------------------------------
        console.log(`${C.bold}── Order Book: XBTSX.XAUT (base) / BTS (quote) ──${C.reset}`);
        console.log(`  get_order_book(${xautAsset.id}, ${btsAsset.id}, 10)`);
        let ob2;
        try {
            ob2 = await BitShares.db.get_order_book(xautAsset.id, btsAsset.id, 10);
            console.log(`  Bids: ${ob2.bids?.length ?? 0}`);
            if (ob2.bids?.length) {
            ob2.bids.forEach((b, i) => console.log(`    ${i+1}. price=${Format.formatPrice(Number(b.price))}  base=${b.base}  quote=${b.quote}`));
        }
        console.log(`  Asks: ${ob2.asks?.length ?? 0}`);
        if (ob2.asks?.length) {
            ob2.asks.forEach((a, i) => console.log(`    ${i+1}. price=${Format.formatPrice(Number(a.price))}  base=${a.base}  quote=${a.quote}`));
            }
        } catch (e) {
            console.log(`${C.red}  Error: ${getErrorMessage(e)}${C.reset}`);
        }
        console.log();

        // ------------------------------------------------------------------
        // 4. Derive mid-price (same logic as DEXBot2's deriveMarketPrice)
        // ------------------------------------------------------------------
        console.log(`${C.bold}── Mid-Price Derivation ──${C.reset}`);
        let mid = null;
        if (ob1?.bids?.length && ob1?.asks?.length) {
            const bid = Number(ob1.bids[0].price);
            const ask = Number(ob1.asks[0].price);
            mid = (bid + ask) / 2;
            console.log(`  OB1 mid (BTS/XAUT): ${Format.formatPrice(mid)}`);
            console.log(`  Inverted (XAUT/BTS): ${Format.formatPrice(1 / mid)}`);
        } else if (ob2?.bids?.length && ob2?.asks?.length) {
            const bid = Number(ob2.bids[0].price);
            const ask = Number(ob2.asks[0].price);
            mid = (bid + ask) / 2;
            console.log(`  OB2 mid (XAUT/BTS): ${Format.formatPrice(mid)}`);
            console.log(`  Inverted (BTS/XAUT): ${Format.formatPrice(1 / mid)}`);
        } else {
            console.log(`${C.yellow}  Cannot derive mid-price — both order books empty or one-sided${C.reset}`);
        }
        console.log();

        // ------------------------------------------------------------------
        // 5. Ticker
        // ------------------------------------------------------------------
        console.log(`${C.bold}── Ticker ──${C.reset}`);
        for (const [label, base, quote] of [
            ['BTS base', btsAsset.id, xautAsset.id],
            ['XAUT base', xautAsset.id, btsAsset.id],
        ]) {
            try {
                const t = await BitShares.db.get_ticker(base, quote);
                console.log(`  ${label}: latest=${t.latest}, latest_price=${t.latest_price}, lowest_ask=${t.lowest_ask}, highest_bid=${t.highest_bid}`);
            } catch (e) {
                console.log(`  ${label}: ${C.red}${getErrorMessage(e)}${C.reset}`);
            }
        }
        console.log();

        // ------------------------------------------------------------------
        // 6. LP pool check
        // ------------------------------------------------------------------
        console.log(`${C.bold}── LP Pool Check ──${C.reset}`);
        let hasPool = false;
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_both_assets(btsAsset.id, xautAsset.id);
            if (pools?.length) {
                hasPool = true;
                console.log(`${C.green}  Found ${pools.length} LP pool(s)${C.reset}`);
                pools.forEach((p, i) => {
                    console.log(`    [${i}] id=${p.id}, share_asset=${p.share_asset}, taker_fee=${p.taker_fee}`);
                });
            } else {
                console.log(`${C.yellow}  No LP pool found for BTS/XBTSX.XAUT${C.reset}`);
            }
        } catch (e) {
            console.log(`  get_liquidity_pools_by_both_assets: ${C.red}${getErrorMessage(e)}${C.reset}`);
            // fallback: try list_liquidity_pools pagination
            try {
                const allPools = await BitShares.db.list_liquidity_pools(100);
                const btsXautPool = allPools.find((p) =>
                    (p.asset_a === btsAsset.id && p.asset_b === xautAsset.id) ||
                    (p.asset_a === xautAsset.id && p.asset_b === btsAsset.id)
                );
                if (btsXautPool) {
                    hasPool = true;
                    console.log(`${C.green}  Found LP pool via list_liquidity_pools:${C.reset}`);
                    console.log(`    id=${btsXautPool.id}, share_asset=${btsXautPool.share_asset}`);
                } else {
                    console.log(`${C.yellow}  No LP pool found (confirmed via list_liquidity_pools)${C.reset}`);
                }
            } catch (e2) {
                console.log(`  list_liquidity_pools fallback error: ${C.red}${getErrorMessage(e2)}${C.reset}`);
            }
        }
        console.log();

        // ------------------------------------------------------------------
        // 7. Market history (recent trades)
        // ------------------------------------------------------------------
        console.log(`${C.bold}── Market History ──${C.reset}`);
        const now = Math.floor(Date.now() / 1000);
        const start = now - 86400;
        const bucketSecs = 3600; // 1h buckets
        try {
            const hist = await BitShares.db.get_market_history(btsAsset.id, xautAsset.id, bucketSecs, start, now);
            console.log(`  ${bucketSecs}s-bucket candles in last 24h: ${hist?.length ?? 0}`);
            if (hist?.length) {
                const first = hist[0];
                const last = hist[hist.length - 1];
                console.log(`  First:  date=${new Date(first.date).toISOString()}, open=${first.open}, high=${first.high}, low=${first.low}, close=${first.close}, volume=${first.volume}`);
                console.log(`  Last:   date=${new Date(last.date).toISOString()}, open=${last.open}, high=${last.high}, low=${last.low}, close=${last.close}, volume=${last.volume}`);
                if (hist.length > 2) {
                    const closes = hist.map(h => Number(h.close));
                    console.log(`  Close range:  [${Math.min(...closes).toFixed(8)}, ${Math.max(...closes).toFixed(8)}]`);
                    console.log(`  Total volume: ${hist.reduce((s, h) => s + Number(h.volume || 0), 0).toFixed(8)}`);
                }
            }
        } catch (e) {
            console.log(`  get_market_history error: ${C.red}${getErrorMessage(e)}${C.reset}`);
            // fallback: get_fill_order_history (limited depth)
            try {
                const fills = await BitShares.db.get_fill_order_history(btsAsset.id, xautAsset.id, 100);
                console.log(`  Recent fills (fallback): ${fills?.length ?? 0}`);
                if (fills?.length) {
                    fills.slice(0, 5).forEach((f, i) => {
                        console.log(`    [${i}] time=${f.time}, price=${f.price}, amount=${f.amount}`);
                    });
                }
            } catch (e2) {
                console.log(`  get_fill_order_history fallback error: ${C.red}${getErrorMessage(e2)}${C.reset}`);
            }
        }
        console.log();

        // ------------------------------------------------------------------
        // 8. Summary / DEXBot2 compatibility
        // ------------------------------------------------------------------
        console.log(`${C.bold}── DEXBot2 Compatibility Assessment ──${C.reset}`);
        const obHasBids = ob1?.bids?.length > 0 || ob2?.bids?.length > 0;
        const obHasAsks = ob1?.asks?.length > 0 || ob2?.asks?.length > 0;

        if (obHasBids && obHasAsks) {
            console.log(`  ${C.green}Order book is two-sided — deriveMarketPrice will succeed${C.reset}`);
        } else if (obHasBids || obHasAsks) {
            console.log(`  ${C.yellow}Order book is one-sided — deriveMarketPrice returns null (no mid-price)${C.reset}`);
        } else {
            console.log(`  ${C.red}Order book is empty — deriveMarketPrice returns null${C.reset}`);
        }

        if (!hasPool) {
            console.log(`  ${C.yellow}No LP pool — startPrice must be "book" (pool mode will throw)${C.reset}`);
        }

        if (isMpa) {
            console.log(`  ${C.green}XBTSX.XAUT has on-chain feed price available via bitasset_data${C.reset}`);
        }
        console.log();

        console.log(`${C.green}${C.bold}Done.${C.reset}`);

    } catch (err) {
        console.error(`${C.red}Fatal: ${getErrorMessage(err)}${C.reset}`);
        process.exit(1);
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
