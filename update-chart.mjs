#!/usr/bin/env node
// Paivittaa BTS/XBTSX.USDT TradingView-chartin tuoreella datalla.
// Kaytto: node update-chart.mjs  (tai kaksoisklikkaa update-chart.cmd)
//
// Huom: kayttaa hae-lp-data.mjs -hakijaa (uusi Kibana-skeema 2026-08-23->),
// koska projektin oma fetch_lp_data.js ei toimiva muuttuneen skeeman kanssa.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fetchLpCandles, fetchLpCandlesIncremental, writeLpFile, findEarliestTradeMs, outputPath } from './hae-lp-data.mjs';

const ROOT = process.cwd();
const CHART_FILE = resolve(ROOT, 'analysis/charts/BTS-XBTSX.USDT_tradingview.html');
// Argumentit:
//   node update-chart.mjs                     -> 24 kk (oletus, inkrementaalinen)
//   node update-chart.mjs 12                  -> 12 kk taaksepain (inkrementaalinen)
//   node update-chart.mjs kaikki              -> koko poolin historia (inkrementaalinen)
//   node update-chart.mjs --since 2024-08-11   -> aloituspäivämäärästä tähän päivään (inkrementaalinen, alias --alku)
//   node update-chart.mjs --full ...          -> pakota tayshaku historiasta (ei inkrementaalista)
// Inkrementaalinen = haetaan Kibanasta vain viimeisen tallennetun kynttilan
// jalkeiset kaupat (yleensa 0-2 sivua eika ~20), historiaa ei haeta uudelleen
// eika trimmata pois: tiedosto kasvaa append-only -historiaksi (megatavut
// halpoja), joten jokainen ikkuna on katettu ensimmaisen tayshaun jalkeen.
const argRaw = String(process.argv[2] || '').trim().toLowerCase();
const FULL_HISTORY = argRaw === 'kaikki' || argRaw === 'all';
const START_FLAG = ['--since', '--start', '--alku'].find((f) => process.argv.indexOf(f) >= 0);
const START_ARG_IDX = START_FLAG ? process.argv.indexOf(START_FLAG) : -1;
const START_DATE = START_ARG_IDX >= 0 && process.argv[START_ARG_IDX + 1]
    ? process.argv[START_ARG_IDX + 1].trim()
    : null;
const START_MS = START_DATE ? Date.parse(START_DATE + 'T00:00:00Z') : null;
const monthsArg = Number(process.argv[2]);
const MONTHS = Number.isFinite(monthsArg) && monthsArg >= 1 ? Math.floor(monthsArg) : 24;
const MONTHS_DAYS = MONTHS * 31;
const AMA_ARGS = ['--ama-er-period', '781', '--ama-fast-period', '5.2', '--ama-slow-period', '62.1'];
const RANGE_LABEL = FULL_HISTORY
    ? 'koko historia'
    : (START_MS != null && Number.isFinite(START_MS))
        ? `${START_DATE} lahtien`
        : MONTHS + ' kk';

function runNode(args) {
    return new Promise((res, rej) => {
        const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
        child.stdout.on('data', (chunk) => process.stdout.write(chunk));
        child.on('error', rej);
        child.on('close', (code) => res(code ?? 0));
    });
}

console.log('='.repeat(50));
console.log('BTS/XBTSX.USDT chartin paivitys (' + RANGE_LABEL + ')');
console.log('='.repeat(50));
console.log();

console.log(`[1/3] Haetaan LP-dataa (pool 1.19.48, 1h kynttilat, ${RANGE_LABEL})...`);
const endMs = Date.now();
let startMs;
if (FULL_HISTORY) {
    const earliest = await findEarliestTradeMs();
    if (earliest == null) {
        console.error('Poolin varhaisinta kauppaa ei loytynyt — peruutetaan.');
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
// Tiedostoon leimattu kattavuus (offline, ei verkkoriippuvuutta): mista
// alkaen sarja on taydellinen. Puuttuu vanhoista tiedostoista.
let storedCoverageFromMs = null;
if (!forceFull) {
    // Inkrementaalinen: tallennettu sarja kattaa pyydetyn ikkunan alun?
    let covered = false;
    try {
        const f = outputPath();
        if (existsSync(f)) {
            const oldRaw = JSON.parse(readFileSync(f, 'utf8'));
            const oc = Array.isArray(oldRaw.candles) ? oldRaw.candles : [];
            const scf = Number(oldRaw.coverageFromMs);
            if (Number.isFinite(scf) && scf > 0) storedCoverageFromMs = scf;
            if (oc.length > 0) {
                const firstOld = Number(oc[0][0]);
                // FULL_HISTORY (kaikki) kattaa aina; muuten vaaditaan alku + 1h toleranssi.
                // Jos ei tayty, tarkista viela onko pyydetty alku ENNEN poolin
                // ensimmaista kauppaa — sita vanhempaa dataa ei ole olemassa,
                // joten sarja on silti kattava (esim. --alku 2024-08-11 kun
                // eka kauppa on 2024-08-11T02:00).
                console.log('  Tiedosto: eka=' + (Number.isFinite(firstOld) ? new Date(firstOld).toISOString() : 'n/a') + ' leima=' + (storedCoverageFromMs != null ? new Date(storedCoverageFromMs).toISOString() : 'n/a'));
                if (FULL_HISTORY) {
                    covered = true;
                } else if (storedCoverageFromMs != null && startMs >= storedCoverageFromMs - 3600000) {
                    console.log('  Kattavuusleima kattaa pyydetyn alun — inkrementaalinen.');
                    covered = true;
                } else if (Number.isFinite(firstOld) && firstOld <= startMs + 3600000) {
                    covered = true;
                } else {
                    let earliest = null;
                    try {
                        earliest = await findEarliestTradeMs();
                    } catch (e) {
                        console.log('  earliest-kysely epaonnistui: ' + (e && e.message ? e.message : String(e)));
                    }
                    console.log('  earliest-tulos: ' + (earliest != null ? new Date(earliest).toISOString() : 'null'));
                    if (earliest != null && startMs <= earliest + 3600000) {
                        console.log('  Pyydetty alku on ennen poolin ensimmaista kauppaa (' + new Date(earliest).toISOString() + ') — sarja kattaa kaiken olemassaolevan.');
                        covered = true;
                    }
                }
            }
        }
    } catch {}
    if (covered) {
        console.log(`[1/3] Paivitetaan vain uudet kynttilat (inkrementaalinen, ${RANGE_LABEL})...`);
        try {
            // Ei trimmausta: historia sailytetaan kokonaan, jotta jokainen
            // ikkuna (myos --alku) on katettu jatkossa ilman tayshakua.
            const res = await fetchLpCandlesIncremental({
                endMs,
                trimStartMs: null,
            });
            payload = res.payload;
            console.log(`  Valmis: ${res.newCandles} uutta kynttilaa.`);
        } catch (err) {
            console.error('Inkrementaalinen haku epaonnistui, kokeillaan tayshakua: ' + (err && err.message ? err.message : String(err)));
        }
    } else if (!FULL_HISTORY) {
        console.log('  Tallennettu sarja ei kata pyydetyn ikkunan alkua — tayshaku.');
    }
}
if (!payload) {
    try {
        payload = await fetchLpCandles({ startMs, endMs });
    } catch (err) {
        console.error('Datanhaku epaonnistui: ' + (err && err.message ? err.message : String(err)));
        process.exit(1);
    }
}
// Merkitaan mihin hintaan EDELLINEN datasettai loppui — charttiin piirretaan
// "updated from here" -viiva tahan kohtaan (uusi data alkaa tastä oikealle).
let prevUpdate = null;
const dataFile = outputPath();
try {
    if (existsSync(dataFile)) {
        const oldRaw = JSON.parse(readFileSync(dataFile, 'utf8'));
        const oc = Array.isArray(oldRaw.candles) ? oldRaw.candles : [];
        if (oc.length > 0) {
            const lastOldMs = Number(oc[oc.length - 1][0]);
            if (Number.isFinite(lastOldMs)) {
                prevUpdate = { lastCandleSec: Math.floor(lastOldMs / 1000) };
                console.log('  Edellinen data loppui: ' + new Date(lastOldMs).toISOString() + ' — merkitaan charttiin');
            }
        }
    }
} catch (e) {}
if (prevUpdate) {
    const newBars = payload.candles.filter((c) => Math.floor(Number(c[0]) / 1000) > prevUpdate.lastCandleSec).length;
    prevUpdate.newBars = newBars;
}
if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload.coverageFromMs = storedCoverageFromMs != null ? storedCoverageFromMs : startMs;
}
writeLpFile(payload, dataFile);
console.log('  Tallennettu: ' + dataFile);
console.log();

console.log('[2/3] Generoidaan TradingView-charttia...');
// Order overlay: same local orders file grid-kuva.mjs uses (explicit
// --orders-file; the analyzer itself carries no hardcoded personal paths).
const _home = process.env.USERPROFILE || process.env.HOME || '';
const ORDER_CANDIDATES = [
    'C:\\Users\\Impulssi\\Desktop\\MouseWithoutBorders\\testo.json',
    'C:\\Users\\Impulssi\\Desktop\\MouseWithoutBorders\\orders\\testo.json',
    resolve(_home, 'Documents', 'VB-shared', 'testo.json'),
    resolve(_home, 'Documents', 'VB-shared', 'orders', 'testo.json'),
    resolve(_home, '.config', 'dexbot2', 'profiles', 'orders', 'testo.json'),
];
let ordersFileArg = [];
for (const p of ORDER_CANDIDATES) { try { if (p && existsSync(p)) { ordersFileArg = ['--orders-file', p]; break; } } catch {} }
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
const chartCode = await runNode([
    'dist/analysis/tradingview/analyze_tradingview.js',
    '--file', dataFile,
    '--chart', CHART_FILE,
    ...AMA_ARGS,
    ...ordersFileArg,
    ...updateMarkerArg,
]);
if (chartCode !== 0) {
    console.error('Chartin generointi epaonnistui (exit ' + chartCode + ').');
    process.exit(1);
}

console.log();
// grid-kuva step removed permanently (unused): run standalone if ever needed:
//   node grid-kuva.mjs --data <lp-data-file>

console.log();
if (process.argv.includes('--no-open')) {
    console.log('[3/3] Selaimen avaus ohitettu (--no-open). Chartti: ' + CHART_FILE);
} else {
console.log('[3/3] Avataan chartti selaimeen...');
try {
    const { exec } = await import('node:child_process');
    const winPath = CHART_FILE.replaceAll('/', '\\');
    // Avaa Brave-selaimessa (kasum polku): fallback cmd start jos ei loydy
    const brave = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
    const { existsSync } = await import('node:fs');
    if (existsSync(brave)) {
        exec('"' + brave + '" "' + winPath + '"', { shell: 'cmd.exe' }, () => {});
    } else {
        exec('start "" "' + winPath + '"', { shell: 'cmd.exe' }, () => {});
    }
} catch (e) {
    console.log('Avaa chartti manuaalisesti: ' + CHART_FILE);
}
}

console.log();
console.log('Valmis! Viimeisin hinta: ' + payload.candles[payload.candles.length - 1][4]);
