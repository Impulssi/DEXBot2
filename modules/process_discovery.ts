'use strict';

import { getStorage } from './storage';
import { runtime } from './runtime';
import { sleep } from './order/utils/system';

const storage = getStorage();

export interface ProcessStat {
    utime: number;
    stime: number;
    starttime: number;
}

export interface ProcessDiscovery {
    isAlive(pid: number): boolean;
    readArgs(pid: number): string[];
    readCmdline(pid: number): string;
    readCwd(pid: number): string;
    readRSSBytes(pid: number): number;
    readStat(pid: number): ProcessStat | null;
    readMemMB(pid: number): string;
    readCpuTime(pid: number): string;
    readCpuPercent(pid: number, samples?: number, intervalMs?: number): Promise<string>;
    readUptime(pid: number): string;
    readSystemUptimeSec(): number;
    readSocketInode(socketPath: string): number;
    findSocketOwnerPid(socketPath: string, isLikelyProcess?: (pid: number) => boolean): number;
    listAllPids(): number[];
}

export class LinuxProcessDiscovery implements ProcessDiscovery {
    isAlive(pid: number): boolean {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            return runtime.kill(pid, 0);
        } catch {
            return false;
        }
    }

    readArgs(pid: number): string[] {
        if (!this.isAlive(pid)) return [];
        try {
            return storage.readFile(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
        } catch {
            return [];
        }
    }

    readCmdline(pid: number): string {
        return this.readArgs(pid).join(' ');
    }

    readCwd(pid: number): string {
        try {
            return storage.realpath(`/proc/${pid}/cwd`);
        } catch {
            return '';
        }
    }

    readRSSBytes(pid: number): number {
        try {
            const statm = storage.readFile(`/proc/${pid}/statm`);
            const parts = statm.trim().split(/\s+/);
            if (parts.length >= 2) {
                return parseInt(parts[1], 10) * 4096;
            }
        } catch {}
        return -1;
    }

    readStat(pid: number): ProcessStat | null {
        try {
            const stat = storage.readFile(`/proc/${pid}/stat`);
            const lastParen = stat.lastIndexOf(')');
            if (lastParen === -1) return null;
            const fields = stat.slice(lastParen + 2).split(/\s+/);
            return {
                utime: parseInt(fields[11], 10) || 0,
                stime: parseInt(fields[12], 10) || 0,
                starttime: parseInt(fields[19], 10) || 0,
            };
        } catch {
            return null;
        }
    }

    readMemMB(pid: number): string {
        try {
            const status = storage.readFile(`/proc/${pid}/status`);
            const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
            if (match) {
                return `${Math.round(parseInt(match[1], 10) / 1024)}MB`;
            }
        } catch {}
        return '-';
    }

    readCpuTime(pid: number): string {
        try {
            const stat = this.readStat(pid);
            if (!stat) return '-';
            const totalSec = (stat.utime + stat.stime) / 100;
            if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
            const m = Math.floor(totalSec / 60);
            const s = Math.floor(totalSec % 60);
            if (m < 60) return `${m}m ${s}s`;
            const h = Math.floor(m / 60);
            return `${h}h ${m % 60}m`;
        } catch {
            return '-';
        }
    }

    async readCpuPercent(pid: number, samples: any = 2, intervalMs: any = 400): Promise<string> {
        try {
            const snap = () => {
                const stat = this.readStat(pid);
                if (!stat) return null;
                return { pidCpu: stat.utime + stat.stime, ts: Date.now() };
            };
            const prev = snap();
            if (!prev) return '-';
            for (let i = 0; i < samples - 1; i++) {
                await sleep(intervalMs);
            }
            const cur = snap();
            if (!cur) return '-';
            const dt = (cur.ts - prev.ts) / 1000;
            const dcpu = (cur.pidCpu - prev.pidCpu) / 100;
            if (dt <= 0) return '-';
            const pct = (dcpu / dt) * 100;
            return `${pct.toFixed(1)}%`;
        } catch {
            return '-';
        }
    }

    readUptime(pid: number): string {
        try {
            const stat = this.readStat(pid);
            if (!stat) return '-';
            const uptimeSec = this.readSystemUptimeSec();
            const clkTck = 100;
            const processStartSec = stat.starttime / clkTck;
            const uptimeMs = (uptimeSec - processStartSec) * 1000;
            return formatUptime(uptimeMs);
        } catch {
            return '-';
        }
    }

    readSystemUptimeSec(): number {
        try {
            return parseFloat(storage.readFile('/proc/uptime').split(/\s+/)[0]);
        } catch {
            return 0;
        }
    }

    readSocketInode(socketPath: string): number {
        if (!socketPath) return 0;
        try {
            const lines = storage.readFile('/proc/net/unix').split('\n');
            for (const line of lines) {
                if (!line) continue;
                const parts = line.trim().split(/\s+/);
                if (parts.length < 7) continue;
                const path = parts[7] || '';
                if (path !== socketPath) continue;
                const inode = Number(parts[6]);
                if (Number.isInteger(inode) && inode > 0) return inode;
            }
        } catch {}
        return 0;
    }

    findSocketOwnerPid(socketPath: string, isLikelyProcess?: (pid: number) => boolean): number {
        const inode = this.readSocketInode(socketPath);
        if (!inode) return 0;
        const target = `socket:[${inode}]`;
        const pids = this.listAllPids();
        for (const pid of pids) {
            const fdDir = `/proc/${pid}/fd`;
            let fds: string[] = [];
            try { fds = storage.readdir(fdDir); } catch { continue; }
            for (const fd of fds) {
                let link: string;
                try { link = storage.readlink(`${fdDir}/${fd}`); } catch { continue; }
                if (link === target) {
                    if (typeof isLikelyProcess === 'function' && !isLikelyProcess(pid)) continue;
                    return pid;
                }
            }
        }
        return 0;
    }

    listAllPids(): number[] {
        try {
            return storage.readdir('/proc')
                .filter((name: any) => /^\d+$/.test(name))
                .map(Number);
        } catch {
            return [];
        }
    }

}

export function formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

export class NullProcessDiscovery implements ProcessDiscovery {
    isAlive(_pid: number): boolean { return false; }
    readArgs(_pid: number): string[] { return []; }
    readCmdline(_pid: number): string { return ''; }
    readCwd(_pid: number): string { return ''; }
    readRSSBytes(_pid: number): number { return -1; }
    readStat(_pid: number): ProcessStat | null { return null; }
    readMemMB(_pid: number): string { return '-'; }
    readCpuTime(_pid: number): string { return '-'; }
    async readCpuPercent(_pid: number, _samples?: number, _intervalMs?: number): Promise<string> { return '-'; }
    readUptime(_pid: number): string { return '-'; }
    readSystemUptimeSec(): number { return 0; }
    readSocketInode(_socketPath: string): number { return 0; }
    findSocketOwnerPid(_socketPath: string, _isLikelyProcess?: (pid: number) => boolean): number { return 0; }
    listAllPids(): number[] { return []; }
}

let _instance: ProcessDiscovery | null = null;

export function setProcessDiscovery(impl: ProcessDiscovery | null): void {
    _instance = impl;
}

export function resetProcessDiscovery(): void {
    _instance = null;
}

export function getProcessDiscovery(): ProcessDiscovery {
    if (!_instance) {
        _instance = runtime.platform === 'linux'
            ? new LinuxProcessDiscovery()
            : new NullProcessDiscovery();
    }
    return _instance;
}
