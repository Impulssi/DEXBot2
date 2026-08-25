'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, writeJSON } = require('../../modules/storage').getStorage();

const { PATHS } = require('../../modules/paths');
const PROFILES_DIR = PATHS.PROFILES_DIR;
const ORDERS_DIR = PATHS.ORDERS_DIR;
const {
    whitelistFile,
} = require('../../modules/market_adapter_whitelist');

function readOptionalFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { exists: false, content: null };
    }
    return {
        exists: true,
        content: fs.readFileSync(filePath, 'utf8'),
    };
}

function restoreOptionalFile(filePath, original) {
    if (original.exists) {
        fs.writeFileSync(filePath, original.content, 'utf8');
        return;
    }
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

function withDynamicWeightFiles(botKey) {
    const snapshotFile = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    const originalWhitelist = readOptionalFile(whitelistFile());
    const originalSnapshot = readOptionalFile(snapshotFile);

    ensureDir(ORDERS_DIR);
    fs.writeFileSync(
        whitelistFile(),
        JSON.stringify({
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: true },
            },
        }, null, 2),
        'utf8'
    );

    return {
        writeSnapshot({ isReady, effectiveWeights, baseWeights = { sell: 0.6, buy: 0.4 }, centerPrice = 100 }) {
            fs.writeFileSync(
                snapshotFile,
                JSON.stringify({
                    centerPrice,
                    updatedAt: '2026-04-22T00:00:00.000Z',
                    dynamicWeights: {
                        isReady,
                        trend: 'NEUTRAL',
                        confidence: 0,
                        effectiveWeights,
                        baseWeights,
                    },
                }, null, 2),
                'utf8'
            );
        },
        cleanup() {
            restoreOptionalFile(snapshotFile, originalSnapshot);
            restoreOptionalFile(whitelistFile(), originalWhitelist);
        },
    };
}

module.exports = {
    withDynamicWeightFiles,
} as any;
