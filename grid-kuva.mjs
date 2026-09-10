// grid-kuva.mjs — Generoi interaktiivisen grid-visualisoinnin BTS/XBTSX.USDT-charttiin.
// Nayttaa hintahistorian + AMA1-linjan ja gridin (orderit nelioina) AMA-hintaan ankkuroituna.
// Aikaliuku (slider) siirtaa gridia historian ajassa — nakee miten grid seuraa AMA:ta.
//
// Kaytto: node grid-kuva.mjs   ->  analysis/charts/BTS-XBTSX.USDT_grid.html
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const home = process.env.USERPROFILE || process.env.HOME;
// Datatiedosto: paivita-chart.mjs antaa --data-polun (sama tiedosto jonka
// TradingView-chart juuri kirjoitti) — taataan sama data molemmissa.
// Ilman argumenttia fallback vanhaan oletuspolkuun.
const dataIdx = process.argv.indexOf('--data');
const SRC = (dataIdx >= 0 && process.argv[dataIdx + 1])
  ? process.argv[dataIdx + 1]
  : join(home, '.config', 'dexbot2', 'profiles', 'market_adapter', 'data', 'lp', 'bts_xbtsx_usdt', 'lp_pool_48_1h.json');
const OUT = join(process.cwd(), 'analysis', 'charts', 'BTS-XBTSX.USDT_grid.html');
if (dataIdx >= 0) console.log('[grid-kuva] Kaytetaan dataa: ' + SRC);

// ── AMA-presetit (constants.ts AMAS: ER=781, fast=5.2 kiinteä) ──
const AMA_SLOW = { ama1: 62.1, ama2: 72.0, ama3: 83.6, ama4: 96.9 };
let GRIDPRICE_NODE = 'ama1';
let SLOW_NODE = AMA_SLOW.ama1;
const ER_NODE = 781, FAST_NODE = 5.2;
function kamaSeries(closes, SLOW) {
    const fastSC = 2 / (FAST_NODE + 1), slowSC = 2 / (SLOW + 1);
    const n = closes.length, out = new Array(n).fill(null);
    if (n <= ER_NODE) return out;
    let sum = 0;
    for (let i = 0; i < ER_NODE; i++) sum += closes[i];
    let ama = sum / ER_NODE;
    out[ER_NODE - 1] = ama;
    for (let i = ER_NODE; i < n; i++) {
        const change = Math.abs(closes[i] - closes[i - ER_NODE]);
        let vol = 0;
        for (let j = i - ER_NODE + 1; j <= i; j++) vol += Math.abs(closes[j] - closes[j - 1]);
        const er = vol > 0 ? change / vol : 0;
        ama += Math.pow(er * (fastSC - slowSC) + slowSC, 2) * (closes[i] - ama);
        out[i] = ama;
    }
    return out;
}

const raw = JSON.parse(readFileSync(SRC, 'utf8'));
const all = raw.candles;
let amaAll = null; // lasketaan konfiguraation latauksen jalkeen (SLOW_NODE)

// ── Aikavalit: [nimi, takaisin-ms, bucket-s] ──
const DAY = 24 * 3600 * 1000;
const PRESETS = [
    ['6 kk', 182 * DAY, 4 * 3600],
    ['1 v', 365 * DAY, 24 * 3600],
    ['2 v', 730 * DAY, 24 * 3600],
    ['Kaikki', Infinity, 7 * 24 * 3600],
];

function aggregate(candles, amas, sinceMs, bucketSec) {
    // amas: {a1:[...], a2:[...], a3:[...], a4:[...]} — jokaiselle oma sarake.
    const bucketMs = bucketSec * 1000;
    const out = [];
    const pushRow = (i, b) => ({
        t: b, o: candles[i][1], h: candles[i][2], l: candles[i][3], c: candles[i][4], v: candles[i][5],
        a1: amas.a1[i], a2: amas.a2[i], a3: amas.a3[i], a4: amas.a4[i],
    });
    for (let i = 0; i < candles.length; i++) {
        if (amas.a1[i] == null) continue;
        const ts = candles[i][0];
        if (ts < sinceMs) continue;
        const b = Math.floor(ts / bucketMs) * bucketMs;
        let cur = out[out.length - 1];
        if (!cur || cur.t !== b) {
            out.push(pushRow(i, b));
        } else {
            cur.h = Math.max(cur.h, candles[i][2]);
            cur.l = Math.min(cur.l, candles[i][3]);
            cur.c = candles[i][4];
            cur.v += candles[i][5];
            cur.a1 = amas.a1[i]; cur.a2 = amas.a2[i]; cur.a3 = amas.a3[i]; cur.a4 = amas.a4[i];
        }
    }
    return out;
}

const now = Date.now();
const series = {};
// Kynttilavali per aikavali (raskas 1h vain lyhyille valeille).
const INTERVALS = { '6 kk': [['1h', 3600], ['4h', 4 * 3600], ['1D', 24 * 3600]], '1 v': [['1h', 3600], ['4h', 4 * 3600], ['1D', 24 * 3600]], '2 v': [['4h', 4 * 3600], ['1D', 24 * 3600]], 'Kaikki': [['1D', 24 * 3600]] };

 // ── Lue botin konfiguraatio automaattisesti (fallback kovakoodattuun) ──
let INC_NODE = 0.0065, SPREAD_NODE = 0.03, LO_NODE = 0.87, HI_NODE = 1.5;
let HI_ABS_NODE = 0; // >0 kun maxPrice on absoluuttinen hinta (ei x-kerroin)
let CFG_NAME_NODE = 'Nykyinen (optimoitu)';
let CFG_NB = 6, CFG_NS = 27;
try {
  const candidates = [];
  // MouseWithoutBorders-kansio ENSIN (kayttajan toive), sitten VB-shared,
  // Desktop vasta fallbackina.
  const MWB = 'C:\\Users\\Impulssi\\Desktop\\MouseWithoutBorders';
  candidates.push(join(MWB, 'bots.json'));
  const vbSharedDirs = [
    join(home, 'Documents', 'VB-shared'),
    'C:\\Users\\Impulssi-999\\Documents\\VB-shared',
    'C:\\Users\\Impulssi\\Documents\\VB-shared',
  ];
  for (const d of vbSharedDirs) candidates.push(join(d, 'bots.json'));
  if (process.env.DEXBOT_PROFILE_ROOT) candidates.push(join(process.env.DEXBOT_PROFILE_ROOT, 'bots.json'));
  if (process.env.DEXBOT2_ROOT) candidates.push(join(process.env.DEXBOT2_ROOT, 'profiles', 'bots.json'));
  candidates.push(join(home, '.config', 'dexbot2', 'profiles', 'bots.json'));
  candidates.push(join(home, 'DEXBot2', 'profiles', 'bots.json'));
  candidates.push(join(process.cwd(), 'profiles', 'bots.json'));
  candidates.push(join(home, 'Desktop', 'bots.json'));
  candidates.push(join(process.cwd(), '..', 'profiles', 'bots.json'));
  // Etsi testo kaikista kandidaateista (Ubuntu-konfiguraatio ei ole Windowsissa, joten skannaa kaikki)
  let botsData = null;
  let botsFile = null;
  let bestFind = null;
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const data = JSON.parse(readFileSync(p,'utf8'));
      const raw = Array.isArray(data) ? data : (data.bots || []);
      const cand = raw.find(b => String(b.name||'').toLowerCase()==='testo');
      if (cand) { botsData = data; botsFile = p; bestFind = cand; break; }
      // tallenna fallback jos testo:a ei loydy mutta joku aktiivinen loytyy
      if (!botsData && raw.length) { botsData = data; botsFile = p; }
    } catch {}
  }
  // jos ei loytynyt suoraa osumaa, etsi fallbackista
  if (botsData) {
    const rawBots = Array.isArray(botsData) ? botsData : (botsData.bots || []);
    const find = bestFind || rawBots.find(b => String(b.name||'').toLowerCase()==='testo') || rawBots.find(b=>b.active!==false) || rawBots[0];
    if (find) {
      if (Number.isFinite(find.incrementPercent)) INC_NODE = Number(find.incrementPercent)/100;
      if (Number.isFinite(find.targetSpreadPercent)) SPREAD_NODE = Number(find.targetSpreadPercent)/100;
      const parseX = (v) => {
        if (typeof v === 'string' && String(v).trim().toLowerCase().endsWith('x')) {
          const n = parseFloat(String(v));
          return Number.isFinite(n) && n>0 ? n : null;
        }
        if (Number.isFinite(Number(v)) && Number(v)>0) return Number(v);
        return null;
      };
      const loX = parseX(find.minPrice);
      const hiX = parseX(find.maxPrice);
      const hiIsX = typeof find.maxPrice === 'string' && String(find.maxPrice).trim().toLowerCase().endsWith('x');
      if (loX) LO_NODE = 1/loX;
      // Numeerinen maxPrice (esim. 0.00241221) on absoluuttinen katto, EI kerroin.
      // Valitetaan selaimelle sellaisenaan (HI_ABS_NODE); kerroin-HI vain x-formaatille.
      if (hiX && hiIsX) HI_NODE = hiX;
      else if (hiX && !hiIsX) HI_ABS_NODE = hiX;
      if (find.activeOrders && Number.isFinite(find.activeOrders.buy)) CFG_NB = Number(find.activeOrders.buy);
      if (find.activeOrders && Number.isFinite(find.activeOrders.sell)) CFG_NS = Number(find.activeOrders.sell);
      // gridPrice -> AMA-preset (ama1..ama4), muuten fallback ama1
      const gpRaw = String(find.gridPrice ?? '').trim().toLowerCase();
      if (AMA_SLOW[gpRaw] != null) {
        GRIDPRICE_NODE = gpRaw;
        SLOW_NODE = AMA_SLOW[gpRaw];
      }
      CFG_NAME_NODE = find.name || CFG_NAME_NODE;
      console.log(`[grid-kuva] Ladattu botti "${CFG_NAME_NODE}" ${botsFile}: INC ${(INC_NODE*100).toFixed(2)}% SPREAD ${(SPREAD_NODE*100).toFixed(2)}% LO ${LO_NODE.toFixed(3)} (${loX?loX+'x':''}) HI ${hiIsX ? HI_NODE + ' (' + hiX + 'x)' : 'abs ' + HI_ABS_NODE} B:${CFG_NB}/S:${CFG_NS} GRID ${GRIDPRICE_NODE.toUpperCase()} (slow=${SLOW_NODE})`);
    }
  }
} catch (e) {
  console.warn('[grid-kuva] Botin luku epaonnistui, kaytetaan fallback:', e.message);
}
// Kaikki 4 AMA-sarjaa kerralla (nappivalinta selaimessa ei laske uudelleen)
const closesAll = all.map((c) => c[4]);
const amasAll = {
  a1: kamaSeries(closesAll, AMA_SLOW.ama1),
  a2: kamaSeries(closesAll, AMA_SLOW.ama2),
  a3: kamaSeries(closesAll, AMA_SLOW.ama3),
  a4: kamaSeries(closesAll, AMA_SLOW.ama4),
};
for (const [name, backMs] of PRESETS) {
    const sinceMs = backMs === Infinity ? 0 : now - backMs;
    for (const [ivLabel, bucketSec] of INTERVALS[name]) {
        series[name + '|' + ivLabel] = aggregate(all, amasAll, sinceMs, bucketSec);
    }
}
const RANGES_NODE = Object.fromEntries(Object.entries(INTERVALS).map(([k, v]) => [k, v.map(([l]) => l)]));

let actualOrders = null;
try {
  const orderCandidates = [
    // MouseWithoutBorders ensin (kayttajan toive), sitten VB-shared
    'C:\\Users\\Impulssi\\Desktop\\MouseWithoutBorders\\testo.json',
    'C:\\Users\\Impulssi\\Desktop\\MouseWithoutBorders\\orders\\testo.json',
    join(home, 'Documents', 'VB-shared', 'testo.json'),
    join(home, 'Documents', 'VB-shared', 'orders', 'testo.json'),
    'C:\\Users\\Impulssi-999\\Documents\\VB-shared\\testo.json',
    'C:\\Users\\Impulssi-999\\Documents\\VB-shared\\orders\\testo.json',
    'C:\\Users\\Impulssi\\Documents\\VB-shared\\testo.json',
    'C:\\Users\\Impulssi\\Documents\\VB-shared\\orders\\testo.json',
    join(home, '.config', 'dexbot2', 'profiles', 'orders', 'testo.json'),
    join(home, 'DEXBot2', 'profiles', 'orders', 'testo.json'),
    join(process.cwd(), 'profiles', 'orders', 'testo.json'),
    join(home, 'Desktop', 'orders', 'testo.json'),
    join(home, '.config', 'dexbot2', 'profiles', 'orders', 'testo.json'.replace('testo', CFG_NAME_NODE.toLowerCase())),
  ];
  for (const p of orderCandidates) {
    try {
      if (!existsSync(p)) continue;
      const od = JSON.parse(readFileSync(p,'utf8'));
      if (od && Array.isArray(od.grid) && od.grid.length) {
        const isDeepId = (o) => /^deep-\d+$/.test(o.id || '');
        const buys = od.grid.filter(o => o.type==='buy' && (o.state==='active' || o.state==='partial') && !isDeepId(o)).map(o=>Number(o.price)).filter(n=>n>0).sort((a,b)=>a-b);
        const deepBuys = od.grid.filter(o => o.type==='buy' && (o.state==='active' || o.state==='partial') && isDeepId(o)).map(o=>Number(o.price)).filter(n=>n>0).sort((a,b)=>a-b);
        const sells = od.grid.filter(o => o.type==='sell' && (o.state==='active' || o.state==='partial')).map(o=>Number(o.price)).filter(n=>n>0).sort((a,b)=>a-b);
        if (buys.length || sells.length || deepBuys.length) {
          actualOrders = { buys, sells, deepBuys, updatedAt: od.meta?.updatedAt || null, boundaryIdx: od.boundaryIdx ?? null };
          console.log(`[grid-kuva] Ladattu todelliset orderit ${p}: ${buys.length} buy (${buys[0]?.toPrecision(4)}..${buys[buys.length-1]?.toPrecision(4)}), ${sells.length} sell, ${deepBuys.length} deep (${deepBuys[0]?.toPrecision(4)}..${deepBuys[deepBuys.length-1]?.toPrecision(4)})`);
          break;
        }
      }
    } catch {}
  }
  if (!actualOrders) console.log('[grid-kuva] Todellisia ordereita ei loytynyt — kaytetaan synteettista layouttia');
} catch {}

const payload = { series, lastPrice: all[all.length - 1][4], lastTs: all[all.length - 1][0], actualOrders };

const html = `<!DOCTYPE html>
<html lang="fi"><head><meta charset="UTF-8">
<title>BTS/XBTSX.USDT — Grid-visualisointi</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#131722; color:#d1d4dc; font:14px 'Segoe UI',sans-serif; padding:14px; }
  h1 { font-size:16px; font-weight:600; margin-bottom:2px; }
  .sub { color:#8b949e; font-size:12px; margin-bottom:10px; }
  .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
  button { background:#2a2e39; color:#d1d4dc; border:1px solid #363a45; border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; }
  button:hover { background:#363a45; }
  button.active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
  .cfg-btn.active { background:#26a69a; border-color:#26a69a; }
  input[type=range] { flex:1; min-width:220px; accent-color:#facc15; }
  #dateLbl { color:#facc15; font-weight:600; min-width:150px; text-align:right; }
  #info { background:#1c2128; border:1px solid #30363d; border-radius:8px; padding:10px 14px; margin-top:10px; font-size:13px; line-height:1.7; }
  #info b { color:#fff; }
  .g { color:#26a69a; font-weight:600; } .r { color:#ef5350; font-weight:600; } .y { color:#facc15; font-weight:600; } .p { color:#a855f7; font-weight:600; }
  canvas { width:100%; display:block; border:1px solid #30363d; border-radius:8px; touch-action:none; cursor:grab; }
</style></head><body>
<h1>BTS / XBTSX.USDT — Grid AMA:ta vasten (interaktiivinen)</h1>
<div class="sub">Neliöt = toimeksiantojen sijainnit ja koko. Vihreä = aktiiviset ostot (6), harmaa katkoviiva = virtuaaliset ostot (reserve), punainen = myynnit (27). Liukuajalla siirrät gridiä historiassa. Rulla = zoomaa aikaa, raahaa = siirrä, kaksoisklikkaa = palauta näkymä. Oranssi viiva oikealla = dippivara. <span style="color:#525c68">(build 0903d)</span></div>
<div class="row" id="tfRow"></div>
<div class="row" id="ivRow"></div>
<div class="row" id="cfgRow"></div>
<div class="row" id="amaRow"></div>
<div class="row">
  <span style="font-size:12px;color:#8b949e">Grid AMA:ssa:</span>
  <input type="range" id="slider" min="0" max="100" value="100">
  <span id="dateLbl">-</span>
</div>
<canvas id="cv"></canvas>
<div id="info"></div>
<script>
const DATA = ${JSON.stringify(payload)};
const RANGES = ${JSON.stringify(RANGES_NODE)};
const AMA_KEYS = ['a1', 'a2', 'a3', 'a4'];
let AMA_KEY = '${({ ama1: 'a1', ama2: 'a2', ama3: 'a3', ama4: 'a4' })[GRIDPRICE_NODE] || 'a3'}';
let AMA_LABEL = AMA_KEY.toUpperCase();
const INC = ${INC_NODE}, SPREAD = ${SPREAD_NODE}, LO = ${LO_NODE}, HI = ${HI_NODE};
const HI_ABS = ${HI_ABS_NODE};
const ceilPrice = (P) => HI_ABS > 0 ? HI_ABS : P * HI;
const BUY_OFFSET = 6;
const CONFIGS = [
  { name: '${CFG_NAME_NODE} (auto)', nB: ${CFG_NB}, nS: ${CFG_NS} },
];
let tf = '1 v', candleIv = '1D', cfgIdx = 0, anchorFrac = 1; // 0 = botin todellinen konfiguraatio (oletus)
// Sarja-avain rangesta + kynttilavalista; fallback karkein saatavilla oleva
const seriesKey = () => {
  const avail = RANGES[tf] || [];
  const iv = avail.includes(candleIv) ? candleIv : avail[avail.length - 1];
  return tf + '|' + iv;
};
// Zoom/pan-tila: null = nayta kaikki
let viewStartMs = null, viewEndMs = null;
let yRange = null; // { min, max } jos manuaalinen hintaskaala, null = auto
let lastYLo = null, lastYHi = null; // viimeisin piirretty skaala (pan-kayttoon)

function layout(P, nB, nS) {
  // Eksakti DEXBot2-geometria (createOrderGrid + calculateIdealBoundary):
  // slotit A centerin molemmin puolin (sqrt(step)-offset), gapSlots tyhjaa
  // keskella puolitettuna symmetrisesti AMA:n ymparille.
  const step = 1 + INC;
  const gapSlots = Math.max(2, Math.ceil(Math.log(1 + SPREAD) / Math.log(step)) - 1);
  const down = [], up = [];
  let p = 1 / Math.sqrt(step);
  for (let k = 0; k < nB + gapSlots + 2; k++) { down.push(p); p /= step; }
  p = Math.sqrt(step);
  for (let k = 0; k < nS + gapSlots + 2; k++) { up.push(p); p *= step; }
  const sorted = down.slice().reverse().concat(up);
  const splitIdx = down.length;
  const boundaryIdx = splitIdx - Math.floor(gapSlots / 2) - 1;
  const sellStart = boundaryIdx + gapSlots + 1;
  // Buy ladder: keep LOW (static) — do not crawl to ceiling (see strategy.ts)
  const buys = [];
  for (let i = 0; i < nB && i < splitIdx - Math.floor(gapSlots/2); i++) {
    // lowest buys in the buy rail (farthest from market), not closest to boundary
    buys.push(P * sorted[i]);
  }
  const sells = [];
  for (let i = sellStart; i < sellStart + nS; i++) sells.push(P * sorted[i]);
  // Virtuaaliset ostot: kaikki LO..bottomBuy -valin tasot jotka ovat reservea
  // Lasketaan montako tasoa mahtuu P*LO ja bottomBuyn valiin
  const bottomBuy = buys.length ? buys[0] : P * LO;
  const virtualBuys = [];
  // generoi alaspain bottomBuy:sta kohti P*LO  (max 20 naytettavaa harmaata)
  let vp = bottomBuy / step;
  let cnt = 0;
  while (vp >= P * LO * 0.999 && cnt < 20) {
    virtualBuys.push(vp);
    vp /= step;
    cnt++;
  }
  return { buys: buys.reverse(), virtualBuys, sells, s0: P * sorted[sellStart], gapSlots };
}

const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const PADL = 10, PADR = 86, PADT = 14, PADB = 26;

function draw() {
  const allRows = DATA.series[seriesKey()];
  if (!allRows.length) return;

  // ── Nakyva aikaikkuna (zoom/pan) ──
  let vt0, vt1;
  if (viewStartMs != null && viewEndMs != null && viewEndMs > viewStartMs) {
    vt0 = viewStartMs; vt1 = viewEndMs;
  } else {
    vt0 = allRows[0].t; vt1 = allRows[allRows.length - 1].t;
  }
  // Suodata nakyvat rivit + yksi reuna molemmin puolin jatkuvuuden takia
  const rows = [];
  for (let i = 0; i < allRows.length; i++) {
    if (allRows[i].t >= vt0 - (vt1 - vt0) * 0.02 && allRows[i].t <= vt1 + (vt1 - vt0) * 0.02) {
      rows.push(allRows[i]);
    }
  }
  if (rows.length < 2) rows.push(...allRows.slice(-2));

  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 640;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#131722'; ctx.fillRect(0, 0, W, H);

  const padL = PADL, padR = PADR, padT = PADT, padB = PADB;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const ai = Math.max(0, Math.min(rows.length - 1, Math.round(anchorFrac * (rows.length - 1))));
  const P = rows[ai][AMA_KEY];
  const g = layout(P, CONFIGS[cfgIdx].nB, CONFIGS[cfgIdx].nS);
  // Slider-offset: todelliset orderit kulkevat gridin keskuksen mukana.
  // OFF = ankkuri-AMA - nyky-AMA; liukua 100%:ssa OFF=0 (todelliset hinnat).
  const PlastRaw = rows[rows.length - 1][AMA_KEY];
  const OFF = (PlastRaw != null && P != null) ? P - PlastRaw : 0;
  const actBuys = (DATA.actualOrders && DATA.actualOrders.buys?.length)
    ? DATA.actualOrders.buys.map((b) => b + OFF) : null;
  const actSells = (DATA.actualOrders && DATA.actualOrders.sells?.length)
    ? DATA.actualOrders.sells.map((s) => s + OFF) : null;
  // Syvahylly erikseen: oranssina, ei sekoitu vihreaan rail-ikkunaan.
  // (Node-puoli on jo jakanut deepBuys erilleen tavallisista ostoista.)
  const actDeep = (DATA.actualOrders && DATA.actualOrders.deepBuys?.length)
    ? DATA.actualOrders.deepBuys.map((b) => b + OFF) : null;
  // "ostot loppuvat": todellinen alin osto (offsetoituna) kun actualOrders
  // kaytossa, muuten synteettisen layoutin alin taso
  const useActualHere = actBuys && cfgIdx===0;
  const bottomBuy = useActualHere ? Math.min(...actBuys) : g.buys[g.buys.length - 1];
  const topSell = (useActualHere && actSells) ? Math.max(...actSells) : g.sells[g.sells.length - 1];

  // Y-asteikko NAKYVISTA kynttiloista (tai manuaalisesta yRangesta)
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) { if (r.l < lo) lo = r.l; if (r.h > hi) hi = r.h; }
  lo = Math.min(lo, P * LO, bottomBuy); hi = Math.max(hi, ceilPrice(P), topSell);
  if (yRange) {
    lo = yRange.min;
    hi = yRange.max;
  }
  const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
  lastYLo = lo; lastYHi = hi;

  const t0 = vt0, t1 = vt1 + (vt1 - vt0) * 0.02;
  const X = (t) => padL + (t - t0) / (t1 - t0) * plotW;
  const Y = (p) => padT + (hi - p) / (hi - lo) * plotH;
  const marketPrice = rows[rows.length - 1].c;

  // ── Ruudukko + hinta-akselin arvot ──
  ctx.strokeStyle = '#1c2128'; ctx.lineWidth = 1; ctx.font = '11px Segoe UI'; ctx.fillStyle = '#8b949e';
  for (let i = 0; i <= 6; i++) {
    const y = padT + plotH * i / 6;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    const p = hi - (hi - lo) * i / 6;
    ctx.fillText(p.toPrecision(4), padL + plotW + 8, y + 4);
  }
  for (let i = 0; i <= 8; i++) {
    const x = padL + plotW * i / 8;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
  }

  // ── Vyohykkeet (vihrea ostoalue + harmaa spread POISTETTU kayttajan toiveesta) ──

  // ── Kynttilat ──
  const cw = Math.max(1.5, plotW / rows.length * 0.7);
  for (const r of rows) {
    const x = X(r.t), up = r.c >= r.o;
    ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
    ctx.beginPath(); ctx.moveTo(x, Y(r.h)); ctx.lineTo(x, Y(r.l)); ctx.stroke();
    ctx.fillStyle = up ? '#26a69a' : '#ef5350';
    const y1 = Y(Math.max(r.o, r.c)), y2 = Y(Math.min(r.o, r.c));
    ctx.fillRect(x - cw / 2, y1, cw, Math.max(1, y2 - y1));
  }

  // ── AMA-linja ──
  ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2; ctx.beginPath();
  let started = false;
  for (const r of rows) { const x = X(r.t), y = Y(r[AMA_KEY]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
  ctx.stroke();

  // ── Range-katto (yläraja) ──
  ctx.setLineDash([7, 5]); ctx.lineWidth = 1.5;
  {
    const y = Y(ceilPrice(P));
    ctx.strokeStyle = '#a855f7';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillStyle = '#a855f7'; ctx.fillText('katto ' + (HI_ABS > 0 ? HI_ABS.toPrecision(4) : HI + 'x') + '  ' + ceilPrice(P).toPrecision(4), padL + 6, y - 5);
  }
  ctx.setLineDash([]);

  // ── Dippivara hinta-akselilla (oranssi) ──
  const floorY = Y(P * LO);
  const marketY = Y(marketPrice);
  if (marketPrice > P * LO && floorY > padT && marketY < padT + plotH) {
    const bx = padL + plotW + 4;
    ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx, marketY); ctx.lineTo(bx, floorY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx - 3, marketY); ctx.lineTo(bx + 3, marketY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx - 3, floorY); ctx.lineTo(bx + 3, floorY); ctx.stroke();
    const dipPct = ((marketPrice - P * LO) / marketPrice * 100).toFixed(1);
    const midY = (marketY + floorY) / 2;
    ctx.fillStyle = '#f97316'; ctx.font = '600 11px Segoe UI';
    ctx.fillText('-' + dipPct + '%', bx + 6, midY + 4);
  }

  // ── Vihreat katkoviivat JOKAISELLA ostotasolla ──
  // Sama tyyli kuin "ostot loppuvat", mutta joka tasolla erikseen.
  // Todelliset orderit offsetoituna ankkurin mukaan (liukuvat keskuksen
  // mukana), muuten synteettista portaita.
  {
    const buyLevels = (useActualHere && actBuys)
      ? [...actBuys].sort((a, b) => a - b)
      : [...g.buys].sort((a, b) => a - b);
    ctx.strokeStyle = '#26a69a'; ctx.lineWidth = 1; ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.55;
    for (const bp of buyLevels) {
      const by = Y(bp);
      if (by > padT && by < padT + plotH) {
        ctx.beginPath(); ctx.moveTo(padL, by); ctx.lineTo(padL + plotW, by); ctx.stroke();
      }
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // Oranssit katkoviivat SYVILLA dip-tasoilla (vain todelliset orderit).
  {
    const deepLevels = (useActualHere && actDeep) ? [...actDeep].sort((a, b) => a - b) : [];
    ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.8;
    for (const bp of deepLevels) {
      const by = Y(bp);
      if (by > padT && by < padT + plotH) {
        ctx.beginPath(); ctx.moveTo(padL, by); ctx.lineTo(padL + plotW, by); ctx.stroke();
      }
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // ── Ostotasojen hinnat oikeaan reunaan (korvaa vihreat palkit) ──
  // Tumma pill + vihrea teksti, ei paallekkain (min 13px vali).
  // Hinnat offsetoituna kuten viivat.
  {
    const buyLevels = (useActualHere && actBuys)
      ? [...actBuys].sort((a, b) => a - b)
      : [...g.buys].sort((a, b) => a - b);
    ctx.font = '600 10px Segoe UI';
    ctx.textAlign = 'right';
    let lastLabelY = -Infinity;
    const drawLevelLabel = (bp, color, bg) => {
      const by = Y(bp);
      if (by < padT || by > padT + plotH) return;
      if (Math.abs(by - lastLabelY) < 13) return;
      const txt = Number(bp).toPrecision(4);
      const w = ctx.measureText(txt).width;
      const bx1 = padL + plotW + PADR - 2;
      ctx.fillStyle = bg;
      ctx.fillRect(bx1 - w - 8, by - 8, w + 8, 15);
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.strokeRect(bx1 - w - 8, by - 8, w + 8, 15);
      ctx.fillStyle = color;
      ctx.fillText(txt, bx1 - 4, by + 3.5);
      lastLabelY = by;
    };
    for (const bp of buyLevels) drawLevelLabel(bp, '#26a69a', 'rgba(20,30,28,0.92)');
    // Syvat dip-tasot oranssilla (jaettu lastLabelY estaa tormayksen).
    if (useActualHere && actDeep) {
      for (const bp of [...actDeep].sort((a, b) => a - b)) drawLevelLabel(bp, '#f97316', 'rgba(43,29,20,0.92)');
    }
    // Myyntitasot: punaiset labelit (jaettu lastLabelY estaa tormayksen ostoihin)
    const sellLevels = (useActualHere && actSells)
      ? [...actSells].sort((a, b) => a - b)
      : [...g.sells].sort((a, b) => a - b);
    for (const sp of sellLevels) drawLevelLabel(sp, '#ef5350', 'rgba(30,20,22,0.92)');
    ctx.textAlign = 'left';
  }

  // ── Punaiset katkoviivat JOKAISELLA myyntitasolla ──
  {
    const sellLevels = (useActualHere && actSells)
      ? [...actSells].sort((a, b) => a - b)
      : [...g.sells].sort((a, b) => a - b);
    ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 1; ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.45;
    for (const sp of sellLevels) {
      const sy = Y(sp);
      if (sy > padT && sy < padT + plotH) {
        ctx.beginPath(); ctx.moveTo(padL, sy); ctx.lineTo(padL + plotW, sy); ctx.stroke();
      }
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // ── Alimman aktiivisen ostotason vaakaviiva ──
  // Vaakasuora katkoviiva chartin poikki — osoittaa reserve-alueen ylarajan.
  // Ylapuolella aktiiviset ostoponit, alapuolella vain reserve/virtuaaliset.
  if (bottomBuy > P * LO) {
    const bby = Y(bottomBuy);
    if (bby > padT && bby < padT + plotH) {
      // Vihrea katkoviiva: aktiivisten ostojen alaraja
      ctx.strokeStyle = '#26a69a'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(padL, bby); ctx.lineTo(padL + plotW, bby); ctx.stroke();
      ctx.setLineDash([]);
      // Tunniste viivan paalle
      const buyPct = ((marketPrice - bottomBuy) / marketPrice * 100).toFixed(1);
      ctx.fillStyle = '#26a69a'; ctx.font = '600 11px Segoe UI';
      ctx.fillText('ostot loppuvat  ' + bottomBuy.toPrecision(4) + '  (-' + buyPct + '%)', padL + 6, bby - 5);
      // Harmaa vaakaviiva: range-lattia (reserve-alueen alaraja)
      const fy = Y(P * LO);
      if (fy > padT && fy < padT + plotH) {
        ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(padL, fy); ctx.lineTo(padL + plotW, fy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#64748b'; ctx.font = '10px Segoe UI';
        const rPct = ((bottomBuy - P * LO) / bottomBuy * 100).toFixed(1);
        ctx.fillText('reserve  ' + rPct + '%', padL + 6, fy - 4);
      }
    }
  }

  // Deep-spread: alimmasta NORMAALISTA ostosta ylimpaan deep-tasoon
  // (ensimmainen deep alaspain menttaessa). Keltaisella valissa.
  if (useActualHere && actBuys && actBuys.length && actDeep && actDeep.length) {
    const railBottom = Math.min(...actBuys);
    const deepTop = Math.max(...actDeep);
    if (deepTop < railBottom) {
      const spr = (railBottom - deepTop) / railBottom * 100;
      const midY = (Y(railBottom) + Y(deepTop)) / 2;
      if (midY > padT && midY < padT + plotH) {
        ctx.fillStyle = '#facc15'; ctx.font = '600 11px Segoe UI';
        ctx.fillText('deep-spread ' + spr.toFixed(1) + '%  (' + railBottom.toPrecision(4) + ' -> ' + deepTop.toPrecision(4) + ')', padL + 6, midY + 4);
      }
    }
  }

  // ── Ankkuripaalu ──
  if (ai < rows.length) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.moveTo(X(rows[ai].t), padT); ctx.lineTo(X(rows[ai].t), padT + plotH); ctx.stroke();
  }

  // ── Order-neliot ──
  const boxW = 26;
  function box(price, color, border) {
    const y = Y(price);
    const spacing = plotH * 0.9 / (CONFIGS[cfgIdx].nB + CONFIGS[cfgIdx].nS + 6);
    const h = Math.max(3, Math.min(14, spacing * 0.8));
    ctx.fillStyle = color; ctx.strokeStyle = border; ctx.lineWidth = 1;
    ctx.fillRect(padL + plotW - boxW - 4, y - h / 2, boxW, h);
    ctx.strokeRect(padL + plotW - boxW - 4, y - h / 2, boxW, h);
  }
  // Jos todelliset orderit loytyivat, piirra ne (tarkka), muuten synteettinen layout
  const useActual = DATA.actualOrders && (DATA.actualOrders.buys?.length || DATA.actualOrders.sells?.length) && cfgIdx===0;
  if (useActual) {
    // Punaiset myyntipalkit POISTETTU (katkoviivat + labelit riittavat).
    // Virtuaaliset harmaalla (synteettisesta layoutista, jos aktiivisia < total)
    // Vertailu offsetoituun alarajaan jotta reserve seuraa liukua.
    const actMin = (useActualHere && actBuys) ? Math.min(...actBuys)
      : (DATA.actualOrders && DATA.actualOrders.buys?.length ? Math.min(...DATA.actualOrders.buys) : Infinity);
    for (const vb of (g.virtualBuys||[])) {
      // nayta vain ne jotka ovat aktiivisten alapuolella (reserve)
      if (vb < actMin) {
        const y = Y(vb);
        const spacing = plotH * 0.9 / (CONFIGS[cfgIdx].nB + CONFIGS[cfgIdx].nS + 6);
        const h = Math.max(3, Math.min(14, spacing * 0.8));
        ctx.fillStyle = 'rgba(100,116,139,0.35)'; ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
        ctx.fillRect(padL + plotW - boxW - 4, y - h / 2, boxW, h);
        ctx.strokeRect(padL + plotW - boxW - 4, y - h / 2, boxW, h);
        ctx.setLineDash([]);
      }
    }
    // (myyntipalkit poistettu — katkoviivat + labelit)
  } else {
    // Vihreat ostopalkit POISTETTU (katkoviivat + labelit riittavat).
    function vbox(price) {
      const y = Y(price);
      const spacing = plotH * 0.9 / (CONFIGS[cfgIdx].nB + CONFIGS[cfgIdx].nS + 6);
      const h = Math.max(3, Math.min(14, spacing * 0.8));
      ctx.fillStyle = 'rgba(100,116,139,0.35)'; ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
      ctx.fillRect(padL + plotW - boxW - 4, y - h / 2, boxW, h);
      ctx.strokeRect(padL + plotW - boxW - 4, y - h / 2, boxW, h);
      ctx.setLineDash([]);
    }
    for (const vb of (g.virtualBuys||[])) vbox(vb);
    // (myyntipalkit poistettu — katkoviivat + labelit)
  }

  // Syvat dip-neliot oranssina oikeaan reunaan (todelliset orderit).
  // Erottuvat harmaasta reserve-alueesta.
  if (useActual && useActualHere && actDeep) {
    for (const dp of actDeep) box(dp, 'rgba(249,115,22,0.9)', '#c2410c');
  }

  // ── AMA-taso ──
  ctx.strokeStyle = '#facc15'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, Y(P)); ctx.lineTo(padL + plotW, Y(P)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#facc15';
  ctx.fillText(AMA_LABEL + ' = gridin keskus  ' + P.toPrecision(4), padL + 6, Y(P) + 14);

  // ── Otsikot ──
  ctx.fillStyle = '#26a69a'; ctx.font = '600 12px Segoe UI';
  ctx.fillText('OSTOT (' + CONFIGS[cfgIdx].nB + ')', padL + 6, Y(bottomBuy) + 14);
  ctx.fillStyle = '#ef5350';
  ctx.fillText('MYYNNIT (' + CONFIGS[cfgIdx].nS + ')', padL + 6, Y(topSell) - 6);
  ctx.fillStyle = '#8b949e'; ctx.font = '11px Segoe UI';
  ctx.fillText('spread ' + (SPREAD*100).toFixed(1) + '%', padL + 6, Y(g.s0) - 6);

  document.getElementById('dateLbl').textContent = new Date(rows[ai].t).toLocaleDateString('fi-FI');
  updateInfo(P, g, bottomBuy, topSell, marketPrice, (useActualHere && actDeep) ? [...actDeep] : null);
}

// ── Zoom & Pan ──
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const allRows = DATA.series[seriesKey()];
  if (!allRows.length) return;
  const dStart = allRows[0].t, dEnd = allRows[allRows.length - 1].t;

  let l = viewStartMs ?? dStart;
  let r = viewEndMs ?? dEnd;
  const span = r - l;

  // Hiiren sijainti plot-alueella (0..1)
  const rect = cv.getBoundingClientRect();
  const fx = Math.max(0, Math.min(1, (e.clientX - rect.left - PADL) / (rect.width - PADL - PADR)));
  const center = l + span * fx;

  const factor = e.deltaY < 0 ? 0.8 : 1.25;
  const minSpan = 6 * 3600000; // min 6h
  const maxSpan = (dEnd - dStart) * 3;
  let newSpan = Math.max(minSpan, Math.min(maxSpan, span * factor));

  viewStartMs = center - newSpan * fx;
  viewEndMs = center + newSpan * (1 - fx);
  draw();
}, { passive: false });

let panDrag = false, panStartX = 0, panViewL = 0, panViewR = 0;
let panStartY = 0, panYMin = 0, panYMax = 0;
cv.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
  if (inYAxisZone(e.clientX)) return; // y-akselin drag hoitaa taman
  e.preventDefault();
  panDrag = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  const allRows = DATA.series[seriesKey()];
  panViewL = viewStartMs ?? allRows[0].t;
  panViewR = viewEndMs ?? allRows[allRows.length - 1].t;
  if (yRange) { panYMin = yRange.min; panYMax = yRange.max; }
  else if (lastYLo != null && lastYHi != null) { panYMin = lastYLo; panYMax = lastYHi; }
  else { panYMin = 0; panYMax = 1; }
  document.body.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!panDrag) return;
  const rect = cv.getBoundingClientRect();
  const plotW = rect.width - PADL - PADR;
  const plotH = rect.height - PADT - PADB;
  const dtPerPx = (panViewR - panViewL) / plotW;
  const shift = (panStartX - e.clientX) * dtPerPx;
  viewStartMs = panViewL + shift;
  viewEndMs = panViewR + shift;
  // Pysty: sisalto seuraa kursoria (raahaa alas -> hinnat liikkuvat alas)
  const span = panYMax - panYMin;
  if (span > 0 && plotH > 0) {
    const yShift = (e.clientY - panStartY) / plotH * span;
    yRange = { min: panYMin + yShift, max: panYMax + yShift };
  }
  draw();
});
window.addEventListener('mouseup', () => {
  if (!panDrag) return;
  panDrag = false;
  document.body.style.cursor = '';
});
cv.addEventListener('dblclick', () => {
  viewStartMs = null;
  viewEndMs = null;
  yRange = null; // palauta myos hintaskaala
  draw();
});

// ── Y-akselin zoom/venytys (hintaskaala) ──
function inYAxisZone(clientX) {
  const rect = cv.getBoundingClientRect();
  return clientX - rect.left > rect.width - PADR;
}

cv.addEventListener('wheel', (e) => {
  if (inYAxisZone(e.clientX)) {
    e.preventDefault();
    // Zoomaa hintaskaalaa kursuuriin kohdistettuna
    const rect = cv.getBoundingClientRect();
    const fy = Math.max(0, Math.min(1, (e.clientY - rect.top - PADT) / (rect.height - PADT - PADB)));
    // Nykyinen range (manuaalinen tai datasta)
    const allRows = DATA.series[seriesKey()];
    let ylo = Infinity, yhi = -Infinity;
    for (const r of allRows) { if (r.l < ylo) ylo = r.l; if (r.h > yhi) yhi = r.h; }
    let curMin = yRange ? yRange.min : ylo;
    let curMax = yRange ? yRange.max : yhi;
    const span = curMax - curMin;
    const center = curMin + span * (1 - fy);
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    const newSpan = Math.max(span * 0.01, span * factor);
    yRange = { min: center - newSpan * (1 - fy), max: center + newSpan * fy };
    draw();
  }
}, { passive: false });

let yDrag = false, yDragStartY = 0, yDragRange = null;
cv.addEventListener('mousedown', (e) => {
  if (e.button === 0 && inYAxisZone(e.clientX)) {
    e.preventDefault();
    e.stopPropagation();
    yDrag = true;
    yDragStartY = e.clientY;
    // Talteen nykyinen range
    const allRows = DATA.series[seriesKey()];
    let ylo = Infinity, yhi = -Infinity;
    for (const r of allRows) { if (r.l < ylo) ylo = r.l; if (r.h > yhi) yhi = r.h; }
    yDragRange = yRange ? { ...yRange } : { min: ylo, max: yhi };
    document.body.style.cursor = 'ns-resize';
  }
});
window.addEventListener('mousemove', (e) => {
  if (!yDrag || !yDragRange) return;
  const dy = e.clientY - yDragStartY;
  if (Math.abs(dy) < 2) return;
  const factor = Math.exp(dy / 200);
  const span = yDragRange.max - yDragRange.min;
  const center = (yDragRange.min + yDragRange.max) / 2;
  const newSpan = span * factor;
  yRange = { min: center - newSpan / 2, max: center + newSpan / 2 };
  draw();
});
window.addEventListener('mouseup', () => {
  if (yDrag) {
    yDrag = false;
    document.body.style.cursor = '';
  }
});

function updateInfo(P, g, bottomBuy, topSell, marketPrice, deepArr) {
  const c = CONFIGS[cfgIdx];
  const buySpan = (1 - bottomBuy / P) * 100;          // AMA:sta alimpaan ostoon
  const sellSpan = (topSell / P - 1) * 100;           // AMA:sta ylimpaan myyntiin
  const topBuy = g.buys[g.buys.length - 1];
  const buyLadder = (1 - bottomBuy / topBuy) * 100;   // portaikko: ylimmasta alimpaan ostoon
  const sellLadder = (topSell / g.sells[0] - 1) * 100; // portaikko: alimmat..ylimmat myynti
  const rCenter = (sellSpan / buySpan).toFixed(2);
  const rLadder = (sellLadder / buyLadder).toFixed(2);
  const fits = (bottomBuy >= P * LO) && (topSell <= ceilPrice(P));
  // Dippivara: paljonko hinta voi pudota markkinahinnasta range-lattiaan
  const dipRoom = marketPrice > 0 ? ((marketPrice - P * LO) / marketPrice * 100).toFixed(1) : '-';
  document.getElementById('info').innerHTML =
    '<b>' + c.name + '</b> — B:' + c.nB + ' / S:' + c.nS + ', incr ' + (INC*100).toFixed(2) + '%, spread ' + (SPREAD*100).toFixed(2) + '% (eka myynti +' + ((g.sells[0] / P - 1) * 100).toFixed(1) + '%, viimeinen osto ' + ((topBuy / P - 1) * 100).toFixed(1) + '% AMA:sta)<br>' +
    'AMA:sta mitattuna: ostospan <span class="g">' + buySpan.toFixed(1) + '%</span>, myyntispan <span class="r">' + sellSpan.toFixed(1) + '%</span> → RR <b>1 : ' + rCenter + '</b><br>' +
    'Portaikoittain (spread-reunoista): ostoportaikko <span class="g">' + buyLadder.toFixed(1) + '%</span>, myyntiportaikko <span class="r">' + sellLadder.toFixed(1) + '%</span> → RR <b>1 : ' + rLadder + '</b><br>' +
    'Dippivara: hinta voi pudota <b class="y">-' + dipRoom + '%</b> (markkina ' + marketPrice.toPrecision(4) + ' → lattia ' + (P * LO).toPrecision(4) + ')<br>' +
    'Rajat: <span class="p">' + (P * LO).toPrecision(4) + ' / ' + ceilPrice(P).toPrecision(4) + '</span> — ylimm\u00e4 myynti ' + (topSell / P * 100).toFixed(0) + '% AMA:sta, mahtuu rajoihin: <b>' + (fits ? '✓ kyllä' : '✗ EI — suurenna rangea!') + '</b>' +
    deepInfoHtml(bottomBuy, deepArr);
}

// Syvahyllyn infotiedot: tasot + spread rail-pohjasta ylimpaan deep-tasoon.
function deepInfoHtml(bottomBuy, deepArr) {
  if (!Array.isArray(deepArr) || !deepArr.length) return '';
  const ds = [...deepArr].sort((a, b) => a - b);
  const railBottom = Number(bottomBuy);
  const deepTop = ds[ds.length - 1];
  const spr = (Number.isFinite(railBottom) && railBottom > 0 && deepTop < railBottom)
    ? ' — rail-pohjasta <b class="y">-' + ((railBottom - deepTop) / railBottom * 100).toFixed(1) + '%</b>'
    : '';
  return '<br>Syvahylly (' + ds.length + '): ' + ds.map((d) => Number(d).toPrecision(4)).join(' / ') + spr;
}

// kontrollit
const tfRow = document.getElementById('tfRow');
const refreshIvButtons = () => {
  const ivRow = document.getElementById('ivRow');
  ivRow.innerHTML = '';
  (RANGES[tf] || []).forEach((iv) => {
    const b = document.createElement('button');
    b.textContent = iv; if (iv === candleIv) b.className = 'active';
    b.onclick = () => { candleIv = iv; viewStartMs = null; viewEndMs = null; refreshIvButtons(); draw(); };
    ivRow.appendChild(b);
  });
};
Object.keys(RANGES).forEach((name, i) => {
  const b = document.createElement('button');
  b.textContent = name; if (name === tf) b.className = 'active';
  b.onclick = () => {
    tf = name;
    if (!(RANGES[tf] || []).includes(candleIv)) candleIv = (RANGES[tf] || [])[0];
    viewStartMs = null; viewEndMs = null;
    [...tfRow.children].forEach((x) => x.classList.remove('active')); b.classList.add('active');
    refreshIvButtons(); draw();
  };
  tfRow.appendChild(b);
});
refreshIvButtons();
const cfgRow = document.getElementById('cfgRow');
CONFIGS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'cfg-btn' + (i === cfgIdx ? ' active' : '');
  b.textContent = c.name + ' (B' + c.nB + '/S' + c.nS + ')';
  b.onclick = () => { cfgIdx = i; [...cfgRow.children].forEach((x) => x.classList.remove('active')); b.classList.add('active'); draw(); };
  cfgRow.appendChild(b);
});
// AMA-valinta: ama1..ama4 (sama data, eri hitaus). Oletus = botin gridPrice.
const amaRow = document.getElementById('amaRow');
const AMA_LABELS = { a1: 'AMA1', a2: 'AMA2', a3: 'AMA3', a4: 'AMA4' };
AMA_KEYS.forEach((k) => {
  const b = document.createElement('button');
  b.className = (k === AMA_KEY ? 'cfg-btn active' : 'cfg-btn');
  b.textContent = AMA_LABELS[k];
  b.title = 'Simuloi gridia talla AMA:lla';
  b.onclick = () => {
    AMA_KEY = k; AMA_LABEL = AMA_LABELS[k];
    [...amaRow.children].forEach((x) => x.classList.remove('active')); b.classList.add('active'); draw();
  };
  amaRow.appendChild(b);
});
document.getElementById('slider').oninput = (e) => { anchorFrac = e.target.value / 100; draw(); };
window.addEventListener('resize', draw);
draw();
</script></body></html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log('Tallennettu: ' + OUT);

// Avaa Brave-selaimessa (sama kuin paivita-chart.mjs). Ymparistomuuttujalla
// GRID_KUVA_NO_OPEN=1 avauksen voi estaa (esim. erillisajoissa).
// Kaytetaan detached spawnia: async exec + valiton process.exit tappaisi
// lapsiprosessin ennen kuin selain ehtii kaynnistya.
if (!process.env.GRID_KUVA_NO_OPEN) {
  try {
    const { spawn } = await import('node:child_process');
    const winPath = OUT.replaceAll('/', '\\');
    const brave = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
    let child = null;
    if (existsSync(brave)) {
      child = spawn(brave, [winPath], { detached: true, stdio: 'ignore', shell: false });
    } else {
      child = spawn('cmd.exe', ['/c', 'start', '""', winPath], { detached: true, stdio: 'ignore', shell: false });
    }
    if (child && typeof child.unref === 'function') child.unref();
    console.log('Avattu selaimeen: ' + OUT);
  } catch (e) {
    console.log('Avaa chartti manuaalisesti: ' + OUT);
  }
}
process.exit(0);
