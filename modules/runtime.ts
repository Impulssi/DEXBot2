'use strict';

import { isBrowser } from './env.js';

declare var window: any;

export interface Runtime {
  exit(code?: number): void;
  exitAfterStderrDrain(code: number): void;
  exitCode: number | undefined;
  kill(pid: number, signal?: string | number): boolean;
  onSignal(signal: string, handler: (...args: any[]) => void): void;
  offSignal(signal: string, handler: (...args: any[]) => void): void;
  readonly pid: number;
  readonly platform: string;
  readonly stdout: { isTTY?: boolean; write(data: string): boolean };
  readonly stderr: { isTTY?: boolean; write(data: string): boolean };
  readonly stdin: { isTTY?: boolean; on(event: string, handler: (...args: any[]) => void): void; resume(): void; pause(): void; destroy(): void } | null;
  readonly argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  umask(mask?: number): number;
  getuid(): number | null;
}

class NodeRuntime implements Runtime {
  exit(code?: number): void { process.exit(code); }
  exitAfterStderrDrain(code: number): void {
    this.exitCode = code;
    process.stderr.write('', 'utf8', () => process.exit(code));
  }
  get exitCode(): number | undefined { return process.exitCode as number | undefined; }
  set exitCode(code: number | undefined) { (process as any).exitCode = code; }
  kill(pid: number, signal?: string | number): boolean {
    try {
      process.kill(pid, signal as any);
      return true;
    } catch (e: any) {
      if (e && e.code === 'ESRCH') {
        return false;
      }
      throw e;
    }
  }
  onSignal(signal: string, handler: (...args: any[]) => void): void { process.on(signal as any, handler); }
  offSignal(signal: string, handler: (...args: any[]) => void): void { process.off(signal as any, handler); }
  getuid(): number | null { return typeof process.getuid === 'function' ? process.getuid() : null; }
  get pid(): number { return process.pid; }
  get platform(): string { return process.platform; }
  get stdout(): any { return process.stdout; }
  get stderr(): any { return process.stderr; }
  get stdin(): any { return process.stdin; }
  get argv(): string[] { return process.argv; }
  cwd(): string { return process.cwd(); }
  get env(): Record<string, string | undefined> { return process.env as any; }
  umask(mask?: number): number {
    if (mask !== undefined) { try { return process.umask(mask); } catch { return 0o22; } }
    try { return process.umask(); } catch { return 0o22; }
  }
}

class BrowserRuntime implements Runtime {
  exit(_code?: number): void { }
  exitAfterStderrDrain(_code: number): void { }
  get exitCode(): number | undefined { return undefined; }
  set exitCode(_code: number | undefined) { }
  kill(_pid: number, _signal?: string): boolean { return false; }
  onSignal(signal: string, handler: (...args: any[]) => void): void {
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      if (isBrowser() && window.addEventListener) {
        window.addEventListener('beforeunload', handler);
      }
    }
  }
  offSignal(signal: string, handler: (...args: any[]) => void): void {
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      if (isBrowser() && window.removeEventListener) {
        window.removeEventListener('beforeunload', handler);
      }
    }
  }
  getuid(): number | null { return null; }
  get pid(): number { return 0; }
  get platform(): string { return 'browser'; }
  get stdout(): any { return { isTTY: false, write() { return true; } }; }
  get stderr(): any { return { isTTY: false, write() { return true; } }; }
  get stdin(): any { return null; }
  get argv(): string[] { return []; }
  cwd(): string { return ''; }
  get env(): Record<string, string | undefined> { return {}; }
  umask(_mask?: number): number { return 0; }
}

let _instance: Runtime | null = null;

export function getRuntime(): Runtime {
  if (!_instance) {
    _instance = isBrowser() ? new BrowserRuntime() : new NodeRuntime();
  }
  return _instance;
}

export function setRuntime(impl: Runtime | null): void {
  _instance = impl;
}

const runtime = getRuntime();
export { runtime };
