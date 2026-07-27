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
 * This subsumes the 5 prior implementations:
 *   1. fs_utils.writeJSON             (tmp+rename, no mode/fsync)
 *   2. bots_file_lock.writeJsonFileAtomic (tmp+rename + crypto.randomBytes + ensureDir)
 *   3. atomic_write.writeJsonAtomic   (tmp+rename + Math.random + ensureDir)
 *   4. chain_keys inline              (openSync 0o600 + writeSync + fsyncSync + renameSync)
 *   5. credential_policy inline       (openSync 0o600 + writeSync + fsyncSync + renameSync)
 *   6. account_orders._persist        (writeFileSync + read-fsync + renameSync)
 */


import { getNodeRequire } from '../env';
import { path } from '../path_api';
import { randomBytes } from '../crypto/sync';
import { runtime } from '../runtime';
const _require = getNodeRequire();
let _fs: any;
const fs = new Proxy({} as any, {
    get(_: any, prop: any) {
        if (!_fs && _require) _fs = _require('fs');
        return _fs ? _fs[prop] : undefined;
    }
});

class NodeStorageAdapter {
  readJSON(filePath: any) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  writeJSON(filePath: string, data: any, options: any = {}) {
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

  exists(path: any) {
    return fs.existsSync(path);
  }

  ensureDir(path: string, options: any = {}) {
    const opts: any = { recursive: true };
    if (options.mode !== undefined) opts.mode = options.mode;
    fs.mkdirSync(path, opts);
  }

  unlink(path: any) {
    if (!path) return;
    try { fs.unlinkSync(path); } catch (_) {}
  }

  readFile(path: any, encoding: any = 'utf8') {
    return fs.readFileSync(path, encoding);
  }

  writeFile(path: any, data: any, options: any) {
    fs.writeFileSync(path, data, options ?? 'utf8');
  }

  rename(oldPath: any, newPath: any) {
    fs.renameSync(oldPath, newPath);
  }

  stat(path: any) {
    return fs.statSync(path);
  }

  readdir(path: any) {
    return fs.readdirSync(path);
  }

  open(path: any, flags: any, mode: any) {
    return fs.openSync(path, flags, mode);
  }

  close(fd: any) {
    fs.closeSync(fd);
  }

  write(fd: any, buffer: any, position: any, encoding: any) {
    fs.writeSync(fd, buffer, position, encoding);
  }

  fsync(fd: any) {
    fs.fsyncSync(fd);
  }

  chmod(path: any, mode: any) {
    fs.chmodSync(path, mode);
  }

  realpath(path: any) {
    return fs.realpathSync(path);
  }

  access(path: any, mode: any) {
    return fs.accessSync(path, mode);
  }

  utimes(path: any, atime: any, mtime: any) {
    fs.utimesSync(path, atime, mtime);
  }

  lstat(path: any) {
    return fs.lstatSync(path);
  }

  rmdir(path: any) {
    fs.rmdirSync(path);
  }

  rm(path: any, options: any = {}) {
    fs.rmSync(path, options);
  }

  mkdtemp(prefix: any) {
    return fs.mkdtempSync(prefix);
  }

  readlink(path: any) {
    return fs.readlinkSync(path);
  }

  appendFile(path: any, data: any, options: any) {
    fs.appendFileSync(path, data, options ?? 'utf8');
  }

  async appendFileAsync(path: any, data: any, options: any) {
    await fs.promises.appendFile(path, data, options ?? 'utf8');
  }

  createReadStream(path: any) {
    return fs.createReadStream(path);
  }

  createWriteStream(path: any) {
    return fs.createWriteStream(path);
  }
}

export default NodeStorageAdapter
module.exports = NodeStorageAdapter

