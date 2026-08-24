
import { getProcessDiscovery, formatUptime } from '../process_discovery.js';
import { Config } from '../config.js';
import { runtime } from '../runtime.js';
'use strict';


const STATUS_COLORS = {
    reset: '\x1b[0m',
    title: '\x1b[1;33m',
    label: '\x1b[38;5;208m',
    ok: '\x1b[1;92m',
    warn: '\x1b[1;31m',
    muted: '\x1b[97m',
};

function colorStatus(text: string, color: string, stream: any = runtime.stdout): string {
    return stream.isTTY && !Config.NO_COLOR ? `${color}${text}${STATUS_COLORS.reset}` : text;
}

function statusTitle(text: any) {
    return colorStatus(text, STATUS_COLORS.title);
}

function statusLabel(text: any) {
    return colorStatus(text, STATUS_COLORS.label);
}

function statusBool(value: any) {
    return colorStatus(value ? 'yes' : 'no', value ? STATUS_COLORS.ok : STATUS_COLORS.warn);
}

function statusActiveBotName(name: any) {
    return colorStatus(name, STATUS_COLORS.ok);
}

function statusSuccess(text: any) {
    return colorStatus(text, STATUS_COLORS.ok);
}

function statusError(text: any) {
    return colorStatus(text, STATUS_COLORS.warn, runtime.stderr);
}

function readProcStat(pid: any) {
    return getProcessDiscovery().readStat(pid);
}

function readProcMemMB(pid: any) {
    return getProcessDiscovery().readMemMB(pid);
}

function readProcCpuTime(pid: any) {
    return getProcessDiscovery().readCpuTime(pid);
}

async function readProcCpuPercent(pid: any, samples: any = 2, intervalMs: any = 400) {
    return getProcessDiscovery().readCpuPercent(pid, samples, intervalMs);
}

function readProcUptime(pid: any) {
    return getProcessDiscovery().readUptime(pid);
}

function formatControlUptime(ms: any) {
    return formatUptime(ms);
}

function formatMemoryWithUptime(memory: any, uptime: any) {
    return uptime && uptime !== '-' ? `${memory} (${uptime})` : memory;
}

function printControlStatus(status: any) {
    const entries = Object.entries(status);
    if (entries.length === 0) {
        console.log('No bots');
        return;
    }
    const nameWidth = Math.max(...entries.map(([n]: any) => n.length), 8);
    const header = `${'NAME'.padEnd(nameWidth)} | STATUS    | PID   | RESTARTS | UPTIME`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const [name, s] of entries as [string, any][]) {
        const uptime = s.uptimeMs ? formatControlUptime(s.uptimeMs) : '-';
        console.log(
            `${name.padEnd(nameWidth)} | ${(s.status || '-').padEnd(9)} | ${String(s.pid || '-').padEnd(5)} | ${String(s.restarts).padEnd(8)} | ${uptime}`
        );
    }
}

export { STATUS_COLORS, colorStatus, statusTitle, statusLabel, statusBool, statusActiveBotName, statusSuccess, statusError, readProcStat, readProcMemMB, readProcCpuTime, readProcCpuPercent, readProcUptime, formatControlUptime, formatMemoryWithUptime, printControlStatus }

