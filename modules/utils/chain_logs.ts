/**
 * Chain connection chatter ([Transport] / [NodeManager] / [bitshares_client]
 * status lines) would drown CLI overviews, and the native loggers don't honor
 * setSuppressConnectionLog — so drop their prefixed lines at the console
 * level for the whole run. console.error stays untouched so real failures
 * (thrown errors, per-target fetch failures) still surface.
 */

const CHAIN_LOG_RE = /\[(Transport|NodeManager|bitshares_client)\]/;

function muteChainLogs(): void {
    const _consoleLog = console.log.bind(console);
    const _consoleInfo = console.info.bind(console);
    const _consoleWarn = console.warn.bind(console);
    const mute = (orig: (...args: any[]) => void) => (...args: any[]) => {
        if (args.length > 0 && typeof args[0] === 'string' && CHAIN_LOG_RE.test(args[0])) return;
        orig(...args);
    };
    console.log = mute(_consoleLog) as typeof console.log;
    console.info = mute(_consoleInfo) as typeof console.info;
    console.warn = mute(_consoleWarn) as typeof console.warn;
}

export { muteChainLogs, CHAIN_LOG_RE }
