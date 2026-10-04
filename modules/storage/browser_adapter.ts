import { getErrorMessage } from '../utils/errors.js';
import type { FileStat } from './types.js';
/**
 * BrowserStorageAdapter — in-memory Map backed by IndexedDB.
 *
 * Architecture:
 *   - On construction, schedules an async IndexedDB load into an in-memory Map.
 *     Until the load completes, synchronous reads return undefined/defaults.
 *   - All sync operations (readJSON, writeJSON, exists, etc.) hit the Map.
 *   - Mutations schedule a debounced flush; call `await adapter.flush()`
 *     to persist to IndexedDB immediately.  This matches the browser's
 *     single-tab / single-process concurrency model — no cross-process
 *     atomicity needed.
 *   - Deletions are tracked as tombstones and replayed as IndexedDB deletes
 *     on flush so removed files cannot resurrect on the next load.
 *   - Ingest never overwrites locally newer state: records mutated before
 *     the load cursor reaches them (writes or deletes) keep their value.
 *
 * IndexedDB schema:
 *   DB name: "DEXBotStorage"
 *   Store name: "files"
 *   Key: file path (string)
 *   Value: { content: string, type: 'json' | 'text', mtime: number }
 *
 * If IndexedDB is unavailable (private browsing, SSR), falls back to a
 * MemoryMap adapter that logs a warning.
 */

/** The record persisted in IndexedDB / held in the in-memory Map. */
interface StoredRecord {
  content: string;
  type: 'json' | 'text';
  mtime: number;
  mode?: number;
}

/** Minimal structural IndexedDB surface (avoids depending on DOM lib types). */
interface IDBRequestEvent<T> {
  target: { result: T };
}
interface IDBCursorLike {
  key: string;
  value: StoredRecord;
  continue(): void;
  onsuccess: ((event: IDBRequestEvent<IDBCursorLike | null>) => void) | null;
  onerror: (() => void) | null;
  error: unknown;
}
interface IDBObjectStoreLike {
  openCursor(): IDBCursorLike;
  put(value: StoredRecord, key: string): void;
  delete(key: string): void;
}
interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  error: unknown;
}
interface IDBDatabaseLike {
  transaction(name: string, mode: 'readonly' | 'readwrite'): IDBTransactionLike;
  close(): void;
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): void;
}
interface IDBOpenRequestLike {
  onupgradeneeded: ((event: IDBRequestEvent<IDBDatabaseLike>) => void) | null;
  onsuccess: ((event: IDBRequestEvent<IDBDatabaseLike>) => void) | null;
  onerror: (() => void) | null;
  error: unknown;
}
interface IndexedDBLike {
  open(name: string, version: number): IDBOpenRequestLike;
}

type WriteOptions = { mode?: number; fsync?: boolean; tmpPrefix?: string; flag?: 'w' | 'wx' };

function createBrowserStorageAdapter() {
  const store = new Map<string, StoredRecord>();
  const tombstones = new Set<string>();
  // Paths mutated locally during the startup load window; the ingest cursor
  // must skip them so a stale IndexedDB record cannot revert a fresh write.
  const localMutations = new Set<string>();
  const FLUSH_DEBOUNCE_MS = 500;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Try to open IndexedDB and load all records into memory. */
  async function initFromIndexedDB() {
    let db: IDBDatabaseLike | undefined;
    try {
      db = await openDB();
      const tx = db.transaction('files', 'readonly');
      const cursor = tx.objectStore('files').openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = (event) => {
          const cur = event.target.result;
          if (cur) {
            // Local mutations (writes or deletes) that ran before the cursor
            // reached this key win over the stored record.
            const key = String(cur.key);
            if (!tombstones.has(key) && !localMutations.has(key)) {
              store.set(cur.key, cur.value);
            }
            cur.continue();
          } else {
            resolve();
          }
        };
        cursor.onerror = () => reject(cursor.error);
      });
      // Load window over — ingest can no longer clobber local state.
      localMutations.clear();
    } catch (err) {
      // IndexedDB unavailable — memory-only mode
      console.warn(`BrowserStorageAdapter: IndexedDB load failed (${getErrorMessage(err)}); falling back to memory-only mode`);
    } finally {
      if (db) db.close();
    }
  }

  /** Flush in-memory store back to IndexedDB. */
  async function flush() {
    let db: IDBDatabaseLike | undefined;
    try {
      db = await openDB();
      const tx = db.transaction('files', 'readwrite');
      const os = tx.objectStore('files');
      for (const [key, value] of store) {
        os.put(value, key);
      }
      for (const key of tombstones) {
        // Unconditional: a write to the path clears its tombstone first, so
        // any surviving tombstone means the key must not exist in IndexedDB.
        os.delete(key);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      tombstones.clear();
    } catch (err) {
      // MemoryMap mode — nothing to flush
      console.warn(`BrowserStorageAdapter: IndexedDB flush failed (${getErrorMessage(err)}); changes remain memory-only`);
    } finally {
      if (db) db.close();
    }
  }

  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  function openDB(): Promise<IDBDatabaseLike> {
    const idb = (globalThis as { indexedDB?: IndexedDBLike }).indexedDB;
    if (!idb) return Promise.reject(new Error('IndexedDB is unavailable'));
    return new Promise<IDBDatabaseLike>((resolve, reject) => {
      const request = idb.open('DEXBotStorage', 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files');
        }
      };
      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Kick off async IndexedDB load (non-blocking)
  initFromIndexedDB().catch(() => {});

  const adapter = {
    readJSON<T = unknown>(path: string): T {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return JSON.parse(entry.content) as T;
    },

    writeJSON(path: string, data: unknown, options: WriteOptions = {}) {
      if (options?.flag === 'wx' && store.has(path)) {
        const err = Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
        throw err;
      }
      const content = JSON.stringify(data, null, 2) + '\n';
      store.set(path, {
        content,
        type: 'json',
        mtime: Date.now(),
        mode: options?.mode,
      });
      tombstones.delete(path);
      localMutations.add(path);
      scheduleFlush();
    },

    exists(path: string): boolean {
      return store.has(path);
    },

    ensureDir(_path: string, _options?: { mode?: number }): void {
      // In-memory: directories are implicit
    },

    unlink(path: string): void {
      store.delete(path);
      tombstones.add(path);
      localMutations.add(path);
      scheduleFlush();
    },

    readFile(path: string, encoding: string = 'utf8'): string {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (encoding === 'utf8' || encoding === 'utf-8') return entry.content;
      return entry.content;
    },

    writeFile(path: string, data: string, options?: { mode?: number } | string): void {
      store.set(path, {
        content: data,
        type: 'text',
        mtime: Date.now(),
        mode: typeof options === 'object' ? options.mode : undefined,
      });
      tombstones.delete(path);
      localMutations.add(path);
      scheduleFlush();
    },

    rename(oldPath: string, newPath: string): void {
      const entry = store.get(oldPath);
      if (entry) {
        store.set(newPath, entry);
        store.delete(oldPath);
        tombstones.delete(newPath);
        tombstones.add(oldPath);
        localMutations.add(oldPath);
        localMutations.add(newPath);
        scheduleFlush();
      }
    },

    stat(path: string): FileStat {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return {
        mtimeMs: entry.mtime || 0,
        isFile: () => true,
        isDirectory: () => false,
      };
    },

    readdir(dirPath: string): string[] {
      const normalized = dirPath.endsWith('/') ? dirPath : dirPath + '/';
      const entries = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(normalized)) {
          const rest = key.slice(normalized.length);
          const idx = rest.indexOf('/');
          entries.add(idx === -1 ? rest : rest.slice(0, idx));
        }
      }
      return Array.from(entries);
    },

    open(_path: string, _flags: string | number, _mode?: number): never {
      throw new Error('open() not supported in browser adapter');
    },
    close(): never {
      throw new Error('close() not supported in browser adapter');
    },
    write(): never {
      throw new Error('write() not supported in browser adapter');
    },
    fsync(): never {
      throw new Error('fsync() not supported in browser adapter');
    },
    chmod(): void {
      // no-op in browser
    },
    realpath(path: string): string {
      return path;
    },
    access(): void {
      // no-op — all file operations are permitted in-memory
    },
    utimes(_path: string, _atime: Date | number, _mtime: Date | number): void {
      // no-op in browser
    },
    lstat(path: string): FileStat {
      return this.stat(path);
    },

    rmdir(_path: string): void {
      // no-op in browser
    },

    rm(_path: string, _options?: { recursive?: boolean; force?: boolean }): void {
      // no-op in browser
    },

    mkdtemp(prefix: string): string {
      return `${prefix}${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    },

    readlink(path: string): string {
      return path;
    },

    appendFile(path: string, data: string, options?: { mode?: number } | string): void {
      const existing = store.get(path);
      const newContent = existing ? existing.content + data : data;
      store.set(path, {
        content: newContent,
        type: 'text',
        mtime: Date.now(),
        mode: typeof options === 'object' ? options.mode : undefined,
      });
      tombstones.delete(path);
      localMutations.add(path);
      scheduleFlush();
    },

    appendFileAsync(path: string, data: string, options?: { mode?: number } | string): Promise<void> {
      this.appendFile(path, data, options);
      return Promise.resolve();
    },

    createReadStream(): never {
      throw new Error('createReadStream() not supported in browser adapter');
    },

    createWriteStream(): never {
      throw new Error('createWriteStream() not supported in browser adapter');
    },

    flush,
  };

  return adapter;
}

export default createBrowserStorageAdapter
