
import { path } from '../modules/path_api';
import { getStorage } from '../modules/storage';
import { normalizeAssetSymbol, isExactPair, isSamePair } from './utils/chain';
import { toIntervalLabel } from './interval_utils';
import { PROJECT_ROOT } from './utils/paths';
import { readJSON } from '../modules/utils/fs_utils';
'use strict';

const storage = getStorage();


const ANALYSIS_AMA_FITTING_DIR = path.join(PROJECT_ROOT, 'analysis', 'ama_fitting');
const MARKET_ADAPTER_DIR = path.join(PROJECT_ROOT, 'market_adapter');

function inferIntervalLabel(meta: any) {
    const sec = Number(meta?.intervalSeconds);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return toIntervalLabel(sec);
}

function buildAmaStrategy(name: any, ama: any, color: any, dash: any, lineWidth: any = 1.5) {
    if (!ama) return null;
    return {
        name,
        erPeriod: ama.erPeriod ?? ama.er,
        fastPeriod: ama.fastPeriod ?? ama.fast,
        slowPeriod: ama.slowPeriod ?? ama.slow,
        color,
        dash,
        lineWidth,
    };
}

function loadStrategiesFromResults(resultsPath: any): any {
    if (!resultsPath || !storage.exists(resultsPath)) return null;

    const json = readJSON(resultsPath);
    const meta = json?.meta;
    if (!meta) return null;

    if (meta.amas && meta.amas.AMA1 && meta.amas.AMA2 && meta.amas.AMA3 && meta.amas.AMA4) {
        const order = [
            ['AMA1', '#fb8c00', 'solid'],
            ['AMA2', '#42a5f5', 'dash'],
            ['AMA3', '#66bb6a', 'longdash'],
            ['AMA4', '#ef5350', 'longdashdot'],
        ];
        const out: any[] = [];
        for (const [k, color, dash] of order) {
            const r = meta.amas[k];
            if (!r) continue;
            const cleaned = String(r.label || '')
                .replace(/^AMA\d\s*/i, '')
                .replace(/^[-:\s]+/, '')
                .replace(/min move,\s*/i, '')
                .trim();
            const name = cleaned ? `${k} - ${cleaned}` : k;
            const strat = buildAmaStrategy(name, r, color, dash, 1.5);
            if (strat) out.push(strat);
        }
        return out.length ? out : null;
    }

    const strategies: any[] = [];
    function add(key: any, label: any, color: any, dash: any) {
        const r = meta[key];
        const strat = buildAmaStrategy(label, r, color, dash, 1.5);
        if (strat) strategies.push(strat);
    }

    const areaCap = Number.isFinite(meta.areaCapPct) ? meta.areaCapPct : null;
    const prodCap = Number.isFinite(meta.prodCapPct) ? meta.prodCapPct : null;
    add('bestProdMaxDist', 'MAX PROD/MAXDIST', '#42a5f5', 'dash');
    add('bestAreaMaxDist', 'MAX AREA/MAXDIST', '#fb8c00', 'solid');
    add('bestAreaMaxDistCapped', areaCap === null ? 'MAX AREA/MAXDIST (cap)' : `MAX AREA/MAXDIST (<=${areaCap.toFixed(1)}%)`, '#66bb6a', 'longdash');
    add('bestProdMaxDistCapped', prodCap === null ? 'MAX PROD/MAXDIST (cap)' : `MAX PROD/MAXDIST (<=${prodCap.toFixed(1)}%)`, '#ef5350', 'longdashdot');

    return strategies.length ? strategies : null;
}

function loadStrategiesFromProfiles(profilesPath: any, meta: any): any {
    if (!profilesPath || !storage.exists(profilesPath)) return null;
    if (!meta) return null;

    const json = readJSON(profilesPath);
    const profiles = Array.isArray(json?.profiles) ? json.profiles : [];
    if (profiles.length === 0) return null;

    const assetASymbol = normalizeAssetSymbol(meta?.assetA?.symbol);
    const assetBSymbol = normalizeAssetSymbol(meta?.assetB?.symbol);
    const assetAId = normalizeAssetSymbol(meta?.assetA?.id);
    const assetBId = normalizeAssetSymbol(meta?.assetB?.id);
    const intervalSeconds = Number(meta?.intervalSeconds);
    const intervalLabel = inferIntervalLabel(meta);

    const matches = profiles.map((p: any) => {
        const pA = normalizeAssetSymbol(p?.assetA);
        const pB = normalizeAssetSymbol(p?.assetB);
        const pAId = normalizeAssetSymbol(p?.assetAId);
        const pBId = normalizeAssetSymbol(p?.assetBId);

        const exactBySymbol = assetASymbol && assetBSymbol && isExactPair(assetASymbol, assetBSymbol, pA, pB);
        const exactById = assetAId && assetBId && isExactPair(assetAId, assetBId, pAId, pBId);
        const symmetricBySymbol = assetASymbol && assetBSymbol && isSamePair(assetASymbol, assetBSymbol, pA, pB);
        const symmetricById = assetAId && assetBId && isSamePair(assetAId, assetBId, pAId, pBId);
        const matchRank = (exactBySymbol || exactById) ? 2 : ((symmetricBySymbol || symmetricById) ? 1 : 0);
        return { profile: p, matchRank };
    }).filter((entry: any) => entry.matchRank > 0);
    if (matches.length === 0) return null;

    const exactMatches = matches.filter((entry: any) => entry.matchRank === 2);
    const matchedProfiles = (exactMatches.length > 0 ? exactMatches : matches)
        .map((entry: any) => entry.profile);

    const sameInterval = matchedProfiles.filter((p: any) => {
        if (Number.isFinite(intervalSeconds) && intervalSeconds > 0 && Number(p?.intervalSeconds) === intervalSeconds) {
            return true;
        }
        if (intervalLabel && String(p?.intervalLabel || '').toLowerCase() === intervalLabel.toLowerCase()) {
            return true;
        }
        return false;
    });
    const candidates = sameInterval.length > 0 ? sameInterval : matchedProfiles;
    const profile = [...candidates].sort((a: any, b: any) => {
        const aTs = Date.parse(String(a?.updatedAt || 0)) || 0;
        const bTs = Date.parse(String(b?.updatedAt || 0)) || 0;
        return bTs - aTs;
    })[0];

    const ama1 = profile?.amas?.AMA1;
    const ama2 = profile?.amas?.AMA2;
    const ama3 = profile?.amas?.AMA3;
    const ama4 = profile?.amas?.AMA4;
    if (!ama1 || !ama2 || !ama3 || !ama4) return null;

    return [
        buildAmaStrategy(ama1.name || 'AMA1', ama1, '#fb8c00', 'solid'),
        buildAmaStrategy(ama2.name || 'AMA2', ama2, '#42a5f5', 'dash', 2),
        buildAmaStrategy(ama3.name || 'AMA3', ama3, '#66bb6a', 'longdash'),
        buildAmaStrategy(ama4.name || 'AMA4', ama4, '#ef5350', 'longdashdot'),
    ].filter((x: any): x is any => x != null);
}

function candidateResultsPaths(dataFile: any, extraSearchDirs: any[] = []) {
    const base = path.basename(dataFile, '.json');
    const dirs = [
        path.dirname(dataFile),
        path.dirname(path.dirname(dataFile)),
        ANALYSIS_AMA_FITTING_DIR,
        MARKET_ADAPTER_DIR,
        ...extraSearchDirs,
    ].filter(Boolean);
    const seen = new Set();
    const out: string[] = [];

    for (const dir of dirs) {
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(path.join(resolved, `optimization_results_${base}.json`));
    }

    return out;
}

function loadStrategiesForLpChart({ dataFile, meta, profilesFile, extraSearchDirs = [] }: { dataFile: any; meta: any; profilesFile?: any; extraSearchDirs?: any[] }) {
    for (const resultsPath of candidateResultsPaths(dataFile, extraSearchDirs)) {
        const fromResults = loadStrategiesFromResults(resultsPath);
        if (fromResults) return fromResults;
    }

    return loadStrategiesFromProfiles(profilesFile, meta);
}

export { loadStrategiesForLpChart, loadStrategiesFromProfiles, loadStrategiesFromResults }

