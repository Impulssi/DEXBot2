export interface FileStat {
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  /** @internal Node-only extended properties */
  mode?: number;
  uid?: number;
  size?: number;
  isSymbolicLink?(): boolean;
  isSocket?(): boolean;
}

export interface IStorageAdapter {
  /** Read and parse a JSON file */
  readJSON<T = any>(path: string): T;

  /**
   * Atomically write a JSON file using tmp-file + rename.
   * Unified implementation — replaces all 5 prior atomic-write variants.
   *
   * Options:
   *   - `mode`: file permissions (e.g. 0o600). When set, uses fd-level openSync with the given mode.
   *   - `fsync`: if true, calls fsyncSync on the fd before rename for extra durability.
   *   - `tmpPrefix`: custom temp file prefix (default: `.tmp.${pid}.${Date.now()}.${random}`)
   *   - `flag`: 'w' (default) overwrites via tmp+rename. 'wx' does an atomic
   *     exclusive-create directly on the target — caller must handle EEXIST.
   *     Use 'wx' when the file should be created only if it does not exist.
   */
  writeJSON(path: string, data: any, options?: { mode?: number; fsync?: boolean; tmpPrefix?: string; flag?: 'w' | 'wx' }): void;

  /** Check if a path exists */
  exists(path: string): boolean;

  /** Ensure a directory exists (recursive mkdir) */
  ensureDir(path: string, options?: { mode?: number }): void;

  /** Delete a file; no-op if missing */
  unlink(path: string): void;

  /** Read a file as string */
  readFile(path: string, encoding?: string): string;

  /** Write a file (non-atomic; use writeJSON for structured/atomic writes) */
  writeFile(path: string, data: string, options?: { mode?: number } | string): void;

  /** Rename / move a file */
  rename(oldPath: string, newPath: string): void;

  /** Get file stats */
  stat(path: string): FileStat;

  /** List directory contents */
  readdir(path: string): string[];

  /** Open a file descriptor */
  open(path: string, flags: string | number, mode?: number): number;

  /** Close a file descriptor */
  close(fd: number): void;

  /** Synchronous write to a file descriptor */
  write(fd: number, buffer: string, position?: number | null, encoding?: string): void;

  /** Flush a file descriptor to disk */
  fsync(fd: number): void;

  /** Change file permissions */
  chmod(path: string, mode: number): void;

  /** Resolve symlinks */
  realpath(path: string): string;

  /** Check file access */
  access(path: string, mode?: number): void;

  /** Update file timestamps */
  utimes(path: string, atime: Date | number, mtime: Date | number): void;

  /** Get file stats without following symlinks */
  lstat(path: string): FileStat;

  /** Remove a directory (must be empty) */
  rmdir(path: string): void;

  /** Remove a file or directory tree (recursive, force) */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void;

  /** Create a unique temporary directory */
  mkdtemp(prefix: string): string;

  /** Read the target of a symbolic link */
  readlink(path: string): string;

  /** Append data to a file (creates if missing). Non-atomic. */
  appendFile(path: string, data: string, options?: { mode?: number } | string): void;

  /** Append data to a file asynchronously (creates if missing). Non-atomic. */
  appendFileAsync(path: string, data: string, options?: { mode?: number } | string): Promise<void>;

  /** Create a readable stream for a file (Node-only; throws in browser adapter) */
  createReadStream(path: string): any;

  /** Create a writable stream for a file (Node-only; throws in browser adapter) */
  createWriteStream(path: string): any;
}
