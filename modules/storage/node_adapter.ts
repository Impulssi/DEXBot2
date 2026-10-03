/**
 * NodeStorageAdapter — wraps fs.*Sync calls directly.
 * Single unified atomic-write implementation replaces all prior variants.
 *
 * Atomic write strategy:
 *   writeJSON → tmp file (with crypto.randomBytes for collision resistance)
 *             → optional fd-level write with mode + fsync
 *             → rename over target
 *             → cleanup tmp on failure
 *
 * This subsumes the prior implementations (the old fs_utils shim has been removed):
 *   1. bots_file_lock.writeJsonFileAtomic (tmp+rename + crypto.randomBytes + ensureDir)
 *   3. atomic_write.writeJsonAtomic   (tmp+rename + Math.random + ensureDir)
 *   4. chain_keys inline              (openSync 0o600 + writeSync + fsyncSync + renameSync)
 *   5. credential_policy inline       (openSync 0o600 + writeSync + fsyncSync + renameSync)
 *   6. account_orders._persist        (writeFileSync + read-fsync + renameSync)
 */


import { createRequire } from 'node:module';
import type * as NodeFs from 'node:fs';
import { path } from '../path_api.js';
import { randomBytes } from '../crypto/sync.js';
import { runtime } from '../runtime.js';
import type { FileStat } from './types.js';
const _require = createRequire(import.meta.url);
let _fs: typeof NodeFs | null = null;
const fs = new Proxy({} as typeof NodeFs, {
    get(_target: typeof NodeFs, prop: string | symbol) {
        if (!_fs && _require) _fs = _require('fs') as typeof NodeFs;
        return _fs ? Reflect.get(_fs, prop) : undefined;
    }
});

class NodeStorageAdapter {
  readJSON<T = unknown>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  }

  writeJSON = (filePath: string, data: unknown, options: { mode?: number; fsync?: boolean; tmpPrefix?: string; flag?: 'w' | 'wx' } = {}) => {
    const dir = path.dirname(filePath);
    if (dir && !this.exists(dir)) {
      this.ensureDir(dir);
    }

    const content = JSON.stringify(data, null, 2) + '\n';

    if (options.flag === 'wx') {
      const mode = options.mode ?? 0o666;
      const fd = fs.openSync(filePath, 'wx', mode);
      try {
        fs.writeSync(fd, content, 0, 'utf8');
        if (options.fsync) {
          fs.fsyncSync(fd);
        }
      } finally {
        fs.closeSync(fd);
      }
      return;
    }

    const suffix = options.tmpPrefix || `.${runtime.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`;
    const tmpPath = `${filePath}${suffix}`;

    try {
      if (options.mode !== undefined || options.fsync) {
        const fd = fs.openSync(tmpPath, 'w', options.mode ?? 0o666);
        try {
          fs.writeSync(fd, content, 0, 'utf8');
          if (options.fsync) {
            fs.fsyncSync(fd);
          }
        } finally {
          fs.closeSync(fd);
        }
      } else {
        fs.writeFileSync(tmpPath, content, 'utf8');
      }
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      this.unlink(tmpPath);
      throw err;
    }
  }

  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  ensureDir(path: string, options: { mode?: number } = {}) {
    const opts: { recursive: boolean; mode?: number } = { recursive: true };
    if (options.mode !== undefined) opts.mode = options.mode;
    fs.mkdirSync(path, opts);
  }

  unlink(path: string): void {
    if (!path) return;
    try { fs.unlinkSync(path); } catch (_) {}
  }

  readFile(path: string, encoding: string = 'utf8'): string {
    return fs.readFileSync(path, encoding as BufferEncoding);
  }

  writeFile(path: string, data: string, options?: { mode?: number } | string): void {
    fs.writeFileSync(path, data, (options ?? 'utf8') as NodeFs.WriteFileOptions);
  }

  rename(oldPath: string, newPath: string): void {
    fs.renameSync(oldPath, newPath);
  }

  stat(path: string): FileStat {
    return fs.statSync(path);
  }

  readdir(path: string): string[] {
    return fs.readdirSync(path);
  }

  open(path: string, flags: string | number, mode?: number): number {
    return fs.openSync(path, flags, mode);
  }

  close(fd: number): void {
    fs.closeSync(fd);
  }

  write(fd: number, buffer: string, position?: number | null, encoding?: string): void {
    fs.writeSync(fd, buffer, position ?? null, (encoding ?? 'utf8') as BufferEncoding);
  }

  fsync(fd: number): void {
    fs.fsyncSync(fd);
  }

  chmod(path: string, mode: number): void {
    fs.chmodSync(path, mode);
  }

  realpath(path: string): string {
    return fs.realpathSync(path);
  }

  access(path: string, mode?: number): void {
    fs.accessSync(path, mode);
  }

  utimes(path: string, atime: Date | number, mtime: Date | number): void {
    fs.utimesSync(path, atime, mtime);
  }

  lstat(path: string): FileStat {
    return fs.lstatSync(path);
  }

  rmdir(path: string): void {
    fs.rmdirSync(path);
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    fs.rmSync(path, options);
  }

  mkdtemp(prefix: string): string {
    return fs.mkdtempSync(prefix);
  }

  readlink(path: string): string {
    return fs.readlinkSync(path);
  }

  appendFile(path: string, data: string, options?: { mode?: number } | string): void {
    fs.appendFileSync(path, data, (options ?? 'utf8') as NodeFs.WriteFileOptions);
  }

  async appendFileAsync(path: string, data: string, options?: { mode?: number } | string): Promise<void> {
    await fs.promises.appendFile(path, data, (options ?? 'utf8') as NodeFs.WriteFileOptions);
  }

  createReadStream(path: string) {
    return fs.createReadStream(path);
  }

  createWriteStream(path: string) {
    return fs.createWriteStream(path);
  }
}

export default NodeStorageAdapter
