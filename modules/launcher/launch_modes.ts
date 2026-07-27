
import { Config } from '../config';
const CONTROL_COMMANDS = new Set(['status', 'stat', 'stop', 'delete', 'restart', 'stop-all', 'restart-all', 'shutdown']);

function findFirstPositionalArg(args: string[]): string | null {
    return args.find((arg: string) => !arg.startsWith('-') && arg !== 'claw-only' && !CONTROL_COMMANDS.has(arg)) || null;
}

function extractPasswordFileArg(args: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--password-file' && i + 1 < args.length) {
            return args[i + 1];
        }
        const match = args[i].match(/^--password-file=(.+)$/);
        if (match) return match[1];
    }
    return null;
}

function stripUnlockFlags(args: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--headless' || a === '--isolated' || a === '--dryrun' || a === '--foreground' || a === 'claw-only' || a === '--claw-only' || a === 'credit' || a === '--credit') {
            continue;
        }
        if (a === '--password-file') {
            if (i < args.length - 1) {
                i++; // skip the value
            }
            continue;
        }
        if (a.startsWith('--password-file=')) {
            continue;
        }
        result.push(a);
    }
    return result;
}

function parseUnlockArgs(argv = process.argv) {
    const args = argv.slice(2);
    const clawOnly = args.includes('--claw-only') || args.includes('claw-only');
    const creditOnly = args.includes('--credit') || args.includes('credit');
    const isolated = args.includes('--isolated');
    const dryrun = args.includes('--dryrun');
    const headless = args.includes('--headless');
    const passwordFile = extractPasswordFileArg(args);
    const positionalArgs = stripUnlockFlags(args);

    if (positionalArgs[0] && CONTROL_COMMANDS.has(positionalArgs[0])) {
        let cmd = positionalArgs[0];
        const target = positionalArgs[1] || null;

        // Normalize whole-runtime controls: restart/stop (no target or 'all') → *-all
        const consumedAll = (cmd === 'restart' || cmd === 'stop') && (!target || target === 'all');
        if (consumedAll) {
            cmd += '-all';
        }

        return {
            botName: null,
            clawOnly: false,
            creditOnly: false,
            isolated: false,
            dryrun: false,
            headless: false,
            passwordFile: null,
            control: { cmd, target: consumedAll ? null : target },
        };
    }

    const resolvedBotName = clawOnly ? null : (findFirstPositionalArg(positionalArgs) || Config.BOT_NAME || null);
    return {
        botName: resolvedBotName,
        clawOnly,
        creditOnly,
        isolated,
        dryrun,
        headless,
        passwordFile,
    };
}

const parseUnlockStartArgs = parseUnlockArgs;

function parsePm2Args(argv = process.argv) {
    const args = argv.slice(2);
    const headless = args.includes('--headless');
    const passwordFile = extractPasswordFileArg(args);

    // Strip known flags and their values before determining the command/target
    const filteredArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--headless') continue;
        if (a === '--password-file') { i++; continue; }
        if (a.startsWith('--password-file=')) continue;
        filteredArgs.push(a);
    }
    const command = filteredArgs[0] || null;
    const knownCommands = new Set(['claw-only', '--claw-only', 'update', 'stop', 'delete', 'restart', 'help']);

    if (command === 'claw-only' || command === '--claw-only') {
        return {
            command: 'claw-only',
            target: null,
            clawOnly: true,
            headless,
            passwordFile,
        };
    }

    if (!command || !knownCommands.has(command)) {
        return {
            command: null,
            target: command,
            clawOnly: false,
            headless,
            passwordFile,
        };
    }

    return {
        command,
        target: filteredArgs[1] || null,
        clawOnly: false,
        headless,
        passwordFile,
    };
}

export { findFirstPositionalArg, parsePm2Args, parseUnlockArgs, parseUnlockStartArgs }

