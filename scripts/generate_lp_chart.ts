
import path from 'node:path';
'use strict';


const {
    defaultMarketChartPath,
    generateComparisonLpChart,
    generateLpChartBundle,
    generateMarketLpChart,
    parseLpChartCliArgs,
} = require('../market_adapter/lp_chart_runner');

function showHelp() {
    console.log(`
LP Chart Generator (uPlot)

Usage:
  tsx scripts/generate_lp_chart.ts [options]

Options:
  --data FILE   LP export JSON file
  --file FILE   Alias for --data
  --out FILE    Market chart output HTML file
  --no-open     Suppress browser auto-open
  --help        Show this help
    `);
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = Array.isArray(argv) ? argv : [];
    const parsed = parseLpChartCliArgs(args, {
        dataFlags: ['--data', '--file'],
    });
    let outFile: string | null = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--out' && args[i + 1]) {
            outFile = path.resolve(args[++i]);
        } else if (arg === '--help' || arg === '-h') {
            return { ...parsed, outFile, help: true };
        }
    }
    return { ...parsed, outFile, help: false };
}

interface GenerateLpChartCliOptions {
    dataFile?: string;
    noOpen?: boolean;
    outFile?: string;
    logger?: Console;
    profilesFile?: string;
    comparisonProfilesFile?: string | null;
    defaultStrategies?: { name: string; erPeriod: number; fastPeriod: number; slowPeriod: number; color?: string; dash?: string; lineWidth?: number }[];
}

function generateLpChartCli(options: GenerateLpChartCliOptions = {}) {
    const logger = options.logger ?? console;
    if (!options.outFile) {
        return generateLpChartBundle({
            dataFile: options.dataFile,
            noOpen: options.noOpen,
            logger,
            profilesFile: options.profilesFile,
            comparisonProfilesFile: options.comparisonProfilesFile,
            defaultStrategies: options.defaultStrategies,
        });
    }

    const marketChart = generateMarketLpChart({
        dataFile: options.dataFile,
        noOpen: options.noOpen,
        outFile: options.outFile,
        logger,
        profilesFile: options.profilesFile,
    });
    const comparisonChart = generateComparisonLpChart({
        dataFile: marketChart.dataFile,
        noOpen: true,
        logger,
        defaultStrategies: options.defaultStrategies,
        profilesFile: options.comparisonProfilesFile ?? null,
    });

    return {
        dataFile: marketChart.dataFile,
        marketChart,
        comparisonChart,
    };
}

function run() {
    const { dataFile, noOpen, outFile, help } = parseArgs(process.argv.slice(2));
    if (help) {
        showHelp();
        return;
    }

    return generateLpChartCli({
        dataFile,
        noOpen,
        outFile,
        logger: console,
    });
}

if (require.main === module) {
    run();
}

export { defaultMarketChartPath as defaultUplotMarketChartPath, generateLpChartCli, generateMarketLpChart as generateMarketLpChartUplot, parseArgs, run, showHelp }

