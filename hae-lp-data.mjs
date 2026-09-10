// hae-lp-data.mjs — Hakee BTS/XBTSX.USDT LP-poolin (1.19.48) kynttiladatan Kibanasta.
//
// Tausta: Kibana-indeksin skeema muuttui 2026-08-23 — dokumenttien kentat
// 'operation_history.op' ja 'operation_history.operation_result' ovat nyt
// JSON-merkkijonoja eivatka jaselletya objektia 'op_object_result' ole enaa
// olemassa. DEXBot2:n oma fetch_lp_data.js kysyy vanhalla kenttanimella ja
// palauttaa 0 osumaa. Tama skripti kayttaa uutta skeemaa mutta projektin
// omia kynttilamuuntimia (candle_utils) data-yhteensopivuuden takaamiseksi.
//
// Kaytto: node hae-lp-data.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD]
// Kirjoittaa: ~/.config/dexbot2/profiles/market_adapter/data/lp/bts_xbtsx_usdt/lp_pool_48_1h.json

import https from 'node:https';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tradesToCandles, fillCandleGaps } from './dist/market_adapter/candle_utils.js';

const KIBANA_HOST = 'kibana.bitshares.dev';
const INDEX = 'bitshares-*';
const POOL_ID = '1.19.48';
const ASSET_A = { id: '1.3.0', precision: 5, symbol: 'BTS' };
const ASSET_B = { id: '1.3.5589', precision: 6, symbol: 'XBTSX.USDT' };
const INTERVAL_SECONDS = 3600;
// Palvelin katkaisee suuret vastaukset kesken (ECONNRESET) — pieni sivukoko
// ja rajattu _source pitavat vastaukset pienina.
const PAGE_SIZE = 2000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const POOL_PHRASE = `"pool":"${POOL_ID}"`;

function outputPath() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return join(home, '.config', 'dexbot2', 'profiles', 'market_adapter', 'data', 'lp', 'bts_xbtsx_usdt', 'lp_pool_48_1h.json');
}
export { outputPath };

function kibanaSearchOnce(esQuery) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(esQuery);
        const req = https.request({
            hostname: KIBANA_HOST,
            port: 443,
            path: '/api/console/proxy?path=' + encodeURIComponent(INDEX + '/_search') + '&method=POST',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'kbn-xsrf': 'true',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: REQUEST_TIMEOUT_MS,
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`Kibana HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error('Kibana-vastauksen JSON-jasennys epaonnistui')); }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Kibana-pyynto aikakatkesi')); });
        req.end(body);
    });
}

// Palvelin katkaisee joskus yhteyden (socket hang up) — yrita uudelleen takaiskuviiveella
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function kibanaSearch(esQuery, { retries = 4, backoffMs = 2000 } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await kibanaSearchOnce(esQuery);
        } catch (err) {
            lastErr = err;
            if (attempt < retries) {
                process.stdout.write(`  (yritys ${attempt} epaonnistui: ${err.message} — yritetaan uudelleen ${backoffMs / 1000}s kuluttua)\n`);
                await sleep(backoffMs);
                backoffMs = Math.min(10000, backoffMs * 1.5);
            }
        }
    }
    throw lastErr;
}

function parseJsonStringArray(value) {
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch (e) { return null; }
}

function firstPositiveEntry(entries) {
    if (!Array.isArray(entries)) return null;
    for (const e of entries) {
        const amount = Number(e && e.amount);
        if (Number.isFinite(amount) && amount > 0 && e.asset_id) {
            return { amount, asset_id: String(e.asset_id) };
        }
    }
    return null;
}

function hitToTrade(hit) {
    const src = hit?._source || {};
    const rawTime = String(src.block_data?.block_time || '');
    if (!rawTime) return null;
    const tsMs = Date.parse(rawTime.endsWith('Z') ? rawTime : rawTime + 'Z');
    if (!Number.isFinite(tsMs)) return null;
    const opArr = parseJsonStringArray(src.operation_history?.op);
    const resArr = parseJsonStringArray(src.operation_history?.operation_result);
    if (!opArr || !resArr) return null;
    const opBody = opArr[1] || {};
    if (String(opBody.pool || '') !== POOL_ID) return null; // match_phrase-suodatuksen varmistus
    const resBody = resArr[1] || {};
    const sell = firstPositiveEntry(resBody.paid);
    const received = firstPositiveEntry(resBody.received);
    if (!sell || !received) return null;
    return {
        tsMs,
        sequence: Number(src.operation_id_num) || 0,
        sell,
        received,
    };
}

// Hakee poolin varhaisimman LP-kaupan aikaleiman (koko historian nollakohta)
export async function findEarliestTradeMs() {
    const result = await kibanaSearch({
        size: 1,
        _source: ['block_data.block_time'],
        query: {
            bool: {
                filter: [
                    { term: { operation_type: 63 } },
                    { match_phrase: { 'operation_history.op': POOL_PHRASE } },
                ],
            },
        },
        sort: [{ 'block_data.block_time': { order: 'asc' } }],
    });
    const t = result?.hits?.hits?.[0]?._source?.block_data?.block_time;
    if (!t) return null;
    const ms = Date.parse(String(t).endsWith('Z') ? String(t) : String(t) + 'Z');
    return Number.isFinite(ms) ? ms : null;
}

async function fetchWindowTrades(winStartMs, winEndMs) {
    const trades = [];
    let searchAfter = null;
    for (let page = 1; page <= 100; page++) {
        const query = {
            size: PAGE_SIZE,
            track_total_hits: false,
            _source: ['block_data.block_time', 'operation_history.op', 'operation_history.operation_result', 'operation_id_num'],
            query: {
                bool: {
                    filter: [
                        { term: { operation_type: 63 } },
                        { match_phrase: { 'operation_history.op': POOL_PHRASE } },
                        { range: { 'block_data.block_time': { gte: new Date(winStartMs).toISOString(), lte: new Date(winEndMs).toISOString() } } },
                    ],
                },
            },
            sort: [
                { 'block_data.block_time': { order: 'asc' } },
                { operation_id_num: { order: 'asc' } },
            ],
        };
        if (Array.isArray(searchAfter)) query.search_after = searchAfter;
        const result = await kibanaSearch(query);
        const hits = result?.hits?.hits || [];
        if (hits.length === 0) break;
        for (const hit of hits) {
            const t = hitToTrade(hit);
            if (t) trades.push(t);
        }
        process.stdout.write(`  ${new Date(winStartMs).toISOString().slice(0, 10)}: sivu ${page}, ${hits.length} dok. (${trades.length} kauppaa)\n`);
        if (hits.length < PAGE_SIZE) break;
        const lastSort = hits[hits.length - 1]?.sort;
        if (!Array.isArray(lastSort)) throw new Error('Sivutuksen sort-arot puuttuvat');
        searchAfter = lastSort;
        // Pieni tauko sivujen valilla — palvelin katkaisee yhteydet liian tiheassa sarjassa
        await sleep(250);
    }
    return trades;
}

// Hakee koko valin 90 paivan aikaikkunoissa. Elasticsearchin syva sivutus
// hidastuu rajattomasti, joten ikkunointi pitaa jokaisen ikkunan sivutuksen matalana.
async function fetchAllTrades(startMs, endMs) {
    const WINDOW_MS = 90 * 24 * 3600 * 1000;
    const trades = [];
    let winStart = startMs;
    while (winStart < endMs) {
        const winEnd = Math.min(winStart + WINDOW_MS - 1, endMs);
        const windowTrades = await fetchWindowTrades(winStart, winEnd);
        for (const t of windowTrades) trades.push(t);
        winStart = winEnd + 1;
        await sleep(200);
    }
    return { trades, totalFromServer: null };
}

export async function fetchLpCandles({ startMs, endMs } = {}) {
    const now = Date.now();
    const end = Number.isFinite(endMs) ? endMs : now;
    const start = Number.isFinite(startMs) ? startMs : end - 186 * 24 * 3600 * 1000;
    const bucketMs = INTERVAL_SECONDS * 1000;
    const startTs = Math.floor(start / bucketMs) * bucketMs;
    const endTs = Math.floor(end / bucketMs) * bucketMs;

    console.log(`Haetaan LP-kaupat poolista ${POOL_ID} (${ASSET_A.symbol}/${ASSET_B.symbol})...`);
    console.log(`  Aikavalilla: ${new Date(startTs).toISOString()} -> ${new Date(endTs).toISOString()}`);
    const { trades, totalFromServer } = await fetchAllTrades(startTs, endTs - 1);
    console.log(`  Yhteensaea ${trades.length} kauppaa (palvelin ilmoittaa ${totalFromServer ?? '?'} dokumentista)`);
    if (trades.length === 0) {
        throw new Error('Kibana ei palauttanut yhtaan kauppaa — data lahde voi olla viela indeksoimatta tai palvelussa katko.');
    }

    const consolidated = tradesToCandles(trades, ASSET_A, ASSET_B, INTERVAL_SECONDS);
    // Älä täytä aukkoja ennen ensimmäistä oikeaa kauppaa (pyydetty alkuaika
    // voi olla poolin perustamista aiemmin)
    const effStartTs = consolidated.length ? Math.max(startTs, consolidated[0][0]) : startTs;
    console.log(`  Kaupoista ${consolidated.length} kynttilaa, taytetään aukot...`);
    const candles = fillCandleGaps(consolidated, INTERVAL_SECONDS, effStartTs, endTs);
    console.log(`  Lopullinen sarja: ${candles.length} kynttilaa`);

    const closes = candles.map((c) => c[4]).filter(Number.isFinite);
    if (closes.length) {
        console.log(`  Hinta-alue: ${Math.min(...closes).toPrecision(6)} - ${Math.max(...closes).toPrecision(6)} ${ASSET_B.symbol}/${ASSET_A.symbol}`);
        console.log(`  Viimeisin sulku: ${closes[closes.length - 1].toPrecision(6)} (${new Date(candles[candles.length - 1][0]).toISOString()})`);
    }

    const payload = {
        meta: {
            fetchedAt: new Date().toISOString(),
            source: `https://${KIBANA_HOST} (${INDEX}, op_type 63, pool ${POOL_ID})`,
            pool: POOL_ID,
            assetA: ASSET_A,
            assetB: ASSET_B,
            pair: {
                symbols: `${ASSET_A.symbol}/${ASSET_B.symbol}`,
                ids: `${ASSET_A.id}/${ASSET_B.id}`,
                keyBySymbols: `${ASSET_A.symbol}|${ASSET_B.symbol}`,
                keyByIds: `${ASSET_A.id}|${ASSET_B.id}`,
            },
            intervalSeconds: INTERVAL_SECONDS,
            lookbackHours: Math.round((endTs - startTs) / 3600000),
            candleCount: candles.length,
            priceUnit: `${ASSET_B.symbol} per ${ASSET_A.symbol}`,
            format: '[timestamp_ms, open, high, low, close, volume_A]',
        },
        candles,
    };
    return payload;
}

export function writeLpFile(payload, filePath = outputPath()) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return filePath;
}

/**
 * Inkrementaalinen paivitys: hakee Kibanasta VAIN viimeisen tallennetun
 * kynttilan jalkeiset kaupat ja liittaa ne vanhaan sarjaan. Historia ei
 * muutu, joten sen uudelleenhaku joka ajolla (~20k dokumenttia) on hukkaa.
 *
 * - Pudottaa viimeisen tallennetun kynttilan ja hakee sen aikaleimasta
 *   alkaen (kesken oleva tunti taydentyy oikein).
 * - Tayttaa mahdollisen aukon vanhan pään ja ensimmaisen uuden kaupan
 *   valilta edellisen sulkuhinnalla (hiljaiset tunnit).
 * - Ei uusia kauppoja -> palauttaa vanhan sarjan (ei virhetta).
 * - Rajaa tuloksen tarvittaessa [trimStartMs, endMs]-ikkunaan.
 *
 * @param {Object} opts
 * @param {number} [opts.endMs] - Ikkunan loppu (oletus nyt).
 * @param {number|null} [opts.trimStartMs] - Pudota tata vanhemmat kynttilat.
 * @param {string} [opts.dataFile] - Datatiedoston polku (oletus outputPath()).
 * @returns {Promise<{payload: any, fresh: boolean, newCandles: number}>}
 */
export async function fetchLpCandlesIncremental({ endMs, trimStartMs = null, dataFile = null } = {}) {
    const file = dataFile || outputPath();
    const bucketMs = INTERVAL_SECONDS * 1000;
    const end = Number.isFinite(endMs) ? endMs : Date.now();

    let old = null;
    try {
        if (existsSync(file)) {
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            if (Array.isArray(raw.candles) && raw.candles.length > 0) old = raw;
        }
    } catch (e) {
        console.log('  Vanhaa dataa ei voitu lukea (' + (e && e.message ? e.message : e) + ') — tayshaku.');
    }
    if (!old) {
        const payload = await fetchLpCandles({ endMs: end });
        return { payload, fresh: true, newCandles: payload.candles.length };
    }

    const oldCandles = old.candles;
    const lastTs = Number(oldCandles[oldCandles.length - 1][0]);
    const firstTs = Number(oldCandles[0][0]);
    const cutoff = lastTs - bucketMs; // viimeinen kynttila haetaan uudelleen
    console.log(`  Vanha data: ${oldCandles.length} kynttilaa (${new Date(firstTs).toISOString()} -> ${new Date(lastTs).toISOString()})`);
    console.log(`  Haetaan vain uudet kaupat alkaen ${new Date(cutoff).toISOString()}...`);

    let fresh;
    try {
        fresh = await fetchLpCandles({ startMs: cutoff, endMs: end });
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (/ei palauttanut yhtaan kauppaa/i.test(msg)) {
            console.log('  Ei uusia kauppoja — vanha data kelpaa sellaisenaan.');
            const payload = {
                ...old,
                meta: { ...(old.meta || {}), fetchedAt: new Date().toISOString() },
                candles: oldCandles,
            };
            return { payload, fresh: false, newCandles: 0 };
        }
        throw err;
    }

    // Vanhat ennen cutoffia + aukon taytto edellisella sululla + uudet.
    const merged = oldCandles.filter((c) => Number(c[0]) < cutoff);
    const lastKept = merged.length ? merged[merged.length - 1] : null;
    const freshCandles = [...fresh.candles].sort((a, b) => a[0] - b[0]);
    const have = new Set(merged.map((c) => Number(c[0])));
    const out = [...merged];
    // Aukko vanhan paan ja ensimmaisen uuden kaupan valilla?
    if (lastKept && freshCandles.length) {
        const firstNew = Number(freshCandles[0][0]);
        const px = Number(lastKept[4]);
        for (let t = cutoff; t < firstNew; t += bucketMs) {
            if (!have.has(t)) {
                out.push([t, px, px, px, px, 0]);
                have.add(t);
            }
        }
    }
    for (const c of freshCandles) {
        const t = Number(c[0]);
        if (t < cutoff || have.has(t)) continue;
        out.push(c);
        have.add(t);
    }
    out.sort((a, b) => a[0] - b[0]);

    // Rajaa pyydettyyn ikkunaan (sailyttaa kunkin .cmd:n lupauksen).
    let candles = out;
    if (trimStartMs != null && Number.isFinite(trimStartMs)) {
        candles = out.filter((c) => Number(c[0]) >= trimStartMs);
    }
    const newCandles = candles.filter((c) => Number(c[0]) > lastTs).length;
    console.log(`  Yhdistetty: ${candles.length} kynttilaa (${newCandles} uutta)`);
    const payload = {
        meta: {
            ...((old && old.meta) || {}),
            ...(fresh.meta || {}),
            fetchedAt: new Date().toISOString(),
            candleCount: candles.length,
            lookbackHours: candles.length ? Math.round((candles[candles.length - 1][0] - candles[0][0]) / 3600000) : 0,
            incrementalFrom: new Date(cutoff).toISOString(),
        },
        candles,
    };
    return { payload, fresh: true, newCandles };
}

const isDirectRun = process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href;
if (isDirectRun) {
    const args = process.argv.slice(2);
    function argDate(flag) {
        const i = args.indexOf(flag);
        if (i >= 0 && args[i + 1]) {
            const ms = Date.parse(args[i + 1] + 'T00:00:00Z');
            if (Number.isFinite(ms)) return ms;
        }
        return undefined;
    }
    const startMs = argDate('--start');
    const endMs = argDate('--end');
    try {
        const payload = await fetchLpCandles({ startMs, endMs });
        const out = writeLpFile(payload);
        console.log(`Tallennettu: ${out} (${payload.candles.length} kynttilaa)`);
        process.exit(0);
    } catch (err) {
        console.error('Virhe: ' + (err && err.message ? err.message : String(err)));
        process.exit(1);
    }
}
