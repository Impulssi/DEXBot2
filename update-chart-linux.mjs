#!/usr/bin/env node
// update-chart-linux.mjs — BTS/XBTSX.USDT TradingView-chartin päivitys Ubuntussa.
//
// Ubuntu-vastine Windowsin update-chart.mjs:lle (sama inkrementaalinen
// logiikka: coverageFromMs-leima, append-only kasvu, haetaan vain viimeisen
// tallennetun kynttilän jälkeiset; update-marker edellisen datasetin loppuun).
// Erot Windows-versioon:
//   - ei Brave-avausta (tuloste jaettuun kansioon /media/sf_VB-shared)
//   - ei C:\-polkuja / USERPROFILEa (HOME-pohjaiset polut)
//   - orders-file suoraan live-snapshotista
//
// Käyttö (repojuuresta ~/DEXBot2/DEXBot2):
//   node update-chart-linux.mjs                  -> koko historia (oletus, inkrementaalinen)
//   node update-chart-linux.mjs 12               -> 12 kk taaksepäin (inkrementaalinen)
//   node update-chart-linux.mjs --since 2024-08-11 -> päivämäärästä tähän päivään
//   node update-chart-linux.mjs --full ...       -> pakota täyshaku
//   Valinnat: --data <polku> --chart <polku> --orders-file <polku> --no-update-marker
//
// Inkrementaalinen = haetaan Kibananasta vain viimeisen tallennetun kynttilän
// jälkeiset kaupat; historiaa ei haeta uudelleen eikä trimmata pois:
// tiedosto kasvaa append-only -historiaksi, joten jokainen ikkuna on katettu
// ensimmäisen täyshaun jälkeen.
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { fetchLpCandles, fetchLpCandlesIncremental, writeLpFile, findEarliestTradeMs, findFirstTradeMsInRange } from './hae-lp-data.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '';
const DATA_FILE_DEFAULT = join(HOME, 'DEXBot2', 'profiles', 'market_adapter', 'data', 'lp', 'bts_xbtsx_usdt', 'lp_pool_48_1h_full.json');
const ORDERS_FILE_DEFAULT = join(HOME, 'DEXBot2', 'profiles', 'orders', 'testo.json');
const CHART_FILE_DEFAULT = '/media/sf_VB-shared/tv-full.html';
const CHART_FALLBACK = () => join(HOME, 'DEXBot2', 'profiles', 'analysis', 'charts', 'tv-full.html');

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const argRaw = String(process.argv[2] || '').trim().toLowerCase();
const FULL_HISTORY = argRaw === 'kaikki' || argRaw === 'all' || (!process.argv[2] || process.argv[2].startsWith('-'));
const START_FLAG = ['--since', '--start', '--alku'].find((f) => process.argv.indexOf(f) >= 0);
const START_DATE = START_FLAG ? (argValue(START_FLAG) || '').trim() : null;
const START_MS = START_DATE ? Date.parse(START_DATE + 'T00:00:00Z') : null;
const monthsArg = Number(process.argv[2]);
const MONTHS = Number.isFinite(monthsArg) && monthsArg >= 1 ? Math.floor(monthsArg) : 24;
const MONTHS_DAYS = MONTHS * 31;
const DATA_FILE = argValue('--data') || DATA_FILE_DEFAULT;
const ORDERS_FILE = argValue('--orders-file') || ORDERS_FILE_DEFAULT;
let chartFile = argValue('--chart') || CHART_FILE_DEFAULT;
const AMA_ARGS = ['--ama-er-period', '781', '--ama-fast-period', '5.2', '--ama-slow-period', '62.1'];
const RANGE_LABEL = FULL_HISTORY
    ? 'koko historia'
    : (START_MS != null && Number.isFinite(START_MS))
        ? `${START_DATE} lähtien`
        : MONTHS + ' kk';

function runNode(args) {
    return new Promise((res, rej) => {
        const child = spawn(process.execPath, args, { cwd: SCRIPT_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
        child.stdout.on('data', (chunk) => process.stdout.write(chunk));
        child.on('error', rej);
        child.on('close', (code) => res(code ?? 0));
    });
}

console.log('='.repeat(50));
console.log('BTS/XBTSX.USDT chartin päivitys Linux (' + RANGE_LABEL + ')');
console.log('='.repeat(50));
console.log();
console.log(`Data: ${DATA_FILE}`);

console.log(`[1/3] Haetaan LP-dataa (pool 1.19.48, 1h kynttilät, ${RANGE_LABEL})...`);
const endMs = Date.now();
let startMs;
if (FULL_HISTORY) {
    const earliest = await findEarliestTradeMs();
    if (earliest == null) {
        console.error('Poolin varhaisinta kauppaa ei löytynyt — peruutetaan.');
        process.exit(1);
    }
    startMs = earliest;
    console.log('  Poolin historian alku: ' + new Date(earliest).toISOString());
} else if (START_MS != null && Number.isFinite(START_MS)) {
    startMs = START_MS;
} else {
    startMs = endMs - MONTHS_DAYS * 24 * 3600 * 1000;
}
let payload;
const forceFull = process.argv.includes('--full');
let covered = false;
let storedCoverageFromMs = null;
let firstOldMs = NaN;
if (!forceFull) {
// Tiedostoon leimattu kattavuus (offline, ei verkkoriippuvuutta): mistä
// alkaen sarja on täydellinen. Puuttuu vanhoista tiedostoista.
    // Inkrementaalinen: tallennettu sarja kattaa pyydetyn ikkunan alun?
    try {
        if (existsSync(DATA_FILE)) {
            const oldRaw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
            const oc = Array.isArray(oldRaw.candles) ? oldRaw.candles : [];
            const scf = Number(oldRaw.coverageFromMs);
            if (Number.isFinite(scf) && scf > 0) storedCoverageFromMs = scf;
            if (oc.length > 0) {
                const firstOld = Number(oc[0][0]);
                firstOldMs = firstOld;
                // FULL_HISTORY kattaa aina; muuten vaaditaan alku + 1h toleranssi.
                // Jos ei täyty, tarkista vielä onko pyydetty alku ENNEN poolin
                // ensimmäistä kauppaa — sitä vanhempaa dataa ei ole olemassa,
                // joten sarja on silti kattava.
                console.log('  Tiedosto: eka=' + (Number.isFinite(firstOld) ? new Date(firstOld).toISOString() : 'n/a') + ' leima=' + (storedCoverageFromMs != null ? new Date(storedCoverageFromMs).toISOString() : 'n/a'));
                if (FULL_HISTORY) {
                    covered = true;
                } else if (storedCoverageFromMs != null && startMs >= storedCoverageFromMs - 3600000) {
                    console.log('  Kattavuusleima kattaa pyydetyn alun — inkrementaalinen.');
                    covered = true;
                } else if (Number.isFinite(firstOld) && firstOld <= startMs + 3600000) {
                    covered = true;
                } else {
                    let gapTrade = null;
                    try {
                        gapTrade = await findFirstTradeMsInRange(startMs, firstOld);
                    } catch (e) {
                        console.log('  välitarkistus epäonnistui: ' + (e && e.message ? e.message : String(e)));
                    }
                    let earliest = null;
                    if (gapTrade != null) {
                        try {
                            earliest = await findEarliestTradeMs();
                        } catch (e) {
                            console.log('  earliest-kysely epäonnistui: ' + (e && e.message ? e.message : String(e)));
                        }
                        console.log('  earliest-tulos: ' + (earliest != null ? new Date(earliest).toISOString() : 'null'));
                    } else {
                        console.log('  Välillä ei kauppoja -> inkrementaalinen.');
                        covered = true;
                    }
                    if (earliest != null && startMs <= earliest + 3600000) {
                        console.log('  Pyydetty alku on ennen poolin ensimmäistä kauppaa (' + new Date(earliest).toISOString() + ') — sarja kattaa kaiken olemassaolevan.');
                        covered = true;
                    }
                }
            }
        }
    } catch {}
    if (covered) {
        console.log(`[1/3] Päivitetään vain uudet kynttilät (inkrementaalinen, ${RANGE_LABEL})...`);
        try {
            // Ei trimmausta: historia säilytetään kokonaan, jotta jokainen
            // ikkuna on katettu jatkossa ilman täyshakua.
            const res = await fetchLpCandlesIncremental({
                endMs,
                trimStartMs: null,
                dataFile: DATA_FILE,
            });
            payload = res.payload;
            console.log(`  Valmis: ${res.newCandles} uutta kynttilää.`);
        } catch (err) {
            console.error('Inkrementaalinen haku epäonnistui, kokeillaan täyshakua: ' + (err && err.message ? err.message : String(err)));
        }
    } else if (!FULL_HISTORY) {
        console.log('  Tallennettu sarja ei kata pyydetyn ikkunan alkua — täyshaku.');
    }
}
if (!payload) {
    try {
        payload = await fetchLpCandles({ startMs, endMs });
    } catch (err) {
        console.error('Datanhaku epäonnistui: ' + (err && err.message ? err.message : String(err)));
        process.exit(1);
    }
}
// Merkitään mihin edellinen datasetti loppui — charttiin piirretään
// "updated from here" -viiva tähän kohtaan (uusi data alkaa tästä oikealle).
let prevUpdate = null;
try {
    if (existsSync(DATA_FILE)) {
        const oldRaw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
        const oc = Array.isArray(oldRaw.candles) ? oldRaw.candles : [];
        if (oc.length > 0) {
            const lastOldMs = Number(oc[oc.length - 1][0]);
            if (Number.isFinite(lastOldMs)) {
                prevUpdate = { lastCandleSec: Math.floor(lastOldMs / 1000) };
                console.log('  Edellinen data loppui: ' + new Date(lastOldMs).toISOString() + ' — merkitään charttiin');
            }
        }
    }
} catch (e) {}
if (prevUpdate) {
    const newBars = payload.candles.filter((c) => Math.floor(Number(c[0]) / 1000) > prevUpdate.lastCandleSec).length;
    prevUpdate.newBars = newBars;
}
if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    // Kattavuusleima: havaittu tiedoston alku (firstOldMs) on todistettu
    // kattavuus (append-only, ei trimmausta). Täyshaku todistaa pyynnöstä.
    // Leimaa ei koskaan kavenneta.
    let nextStamp = storedCoverageFromMs;
    if (Number.isFinite(firstOldMs) && firstOldMs > 0 && (nextStamp == null || firstOldMs < nextStamp)) nextStamp = firstOldMs;
    if (nextStamp == null && !covered) nextStamp = startMs;
    if (nextStamp != null) payload.coverageFromMs = nextStamp;
}
mkdirSync(join(DATA_FILE, '..'), { recursive: true });
writeLpFile(payload, DATA_FILE);
console.log('  Tallennettu: ' + DATA_FILE);
console.log();

console.log('[2/3] Generoidaan TradingView-charttia...');
let ordersFileArg = [];
try {
    if (existsSync(ORDERS_FILE)) ordersFileArg = ['--orders-file', ORDERS_FILE];
    else console.log('  Orders-tiedostoa ei löytynyt (' + ORDERS_FILE + ') — ilman overlayta.');
} catch {}
// Update marker ("updated from here" line): previous dataset end + new bar
// count, so the chart shows where this incremental fetch started.
let updateMarkerArg = [];
if (prevUpdate && Number(prevUpdate.lastCandleSec) > 0) {
    updateMarkerArg = ['--update-marker-ts', String(Math.floor(Number(prevUpdate.lastCandleSec)))];
    if (Number.isFinite(Number(prevUpdate.newBars)) && Number(prevUpdate.newBars) >= 0) {
        updateMarkerArg.push('--update-marker-bars', String(Math.floor(Number(prevUpdate.newBars))));
    }
}
// Opt-out: --no-update-marker suppresses the auto-stamped marker entirely.
if (process.argv.includes('--no-update-marker')) updateMarkerArg = [];
// Jaettu kansio ei välttämättä ole mountattu — fallback paikalliseen.
try {
    mkdirSync(join(chartFile, '..'), { recursive: true });
} catch {}
if (!existsSync(join(chartFile, '..'))) {
    chartFile = CHART_FALLBACK();
    console.log('  Jaettu kansio puuttuu — chartti paikalliseen: ' + chartFile);
    mkdirSync(join(chartFile, '..'), { recursive: true });
}
const chartCode = await runNode([
    'dist/analysis/tradingview/analyze_tradingview.js',
    '--file', DATA_FILE,
    '--chart', chartFile,
    ...AMA_ARGS,
    ...ordersFileArg,
    ...updateMarkerArg,
]);
if (chartCode !== 0) {
    console.error('Chartin generointi epäonnistui (exit ' + chartCode + ').');
    process.exit(1);
}

console.log();
console.log('[3/3] Valmis! Chartti: ' + chartFile);
console.log();
console.log('Valmis! Viimeisin hinta: ' + payload.candles[payload.candles.length - 1][4]);
