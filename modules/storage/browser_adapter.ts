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

function createBrowserStorageAdapter() {
  const store = new Map();
  const tombstones = new Set<string>();
  // Paths mutated locally during the startup load window; the ingest cursor
  // must skip them so a stale IndexedDB record cannot revert a fresh write.
  const localMutations = new Set<string>();
  const FLUSH_DEBOUNCE_MS = 500;
  let flushTimer: any = null;

  /** Try to open IndexedDB and load all records into memory. */
  async function initFromIndexedDB() {
    let db;
    try {
      db = await openDB();
      const tx = db.transaction('files', 'readonly');
      const cursor = tx.objectStore('files').openCursor();
      await new Promise<void>((resolve: any, reject: any) => {
        cursor.onsuccess = (event: any) => {
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
    } catch {
      // IndexedDB unavailable — MemoryMap mode
    } finally {
      if (db) db.close();
    }
  }

  /** Flush in-memory store back to IndexedDB. */
  async function flush() {
    let db;
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
      await new Promise<void>((resolve: any, reject: any) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      tombstones.clear();
    } catch {
      // MemoryMap mode — nothing to flush
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

  function openDB() {
    const idb: any = (globalThis as any).indexedDB;
    return new Promise<any>((resolve: any, reject: any) => {
      const request = idb.open('DEXBotStorage', 1);
      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files');
        }
      };
      request.onsuccess = (event: any) => resolve(event.target.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Kick off async IndexedDB load (non-blocking)
  initFromIndexedDB().catch(() => {});

  const adapter = {
    readJSON(path: any) {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return JSON.parse(entry.content);
    },

    writeJSON(path: any, data: any, options: any) {
      if (options?.flag === 'wx' && store.has(path)) {
        const err: any = new Error(`EEXIST: ${path}`);
        err.code = 'EEXIST';
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

    exists(path: any) {
      return store.has(path);
    },

    ensureDir(_path: any, _options: any) {
      // In-memory: directories are implicit
    },

    unlink(path: any) {
      store.delete(path);
      tombstones.add(path);
      localMutations.add(path);
      scheduleFlush();
    },

    readFile(path: any, encoding: any = 'utf8') {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (encoding === 'utf8' || encoding === 'utf-8') return entry.content;
      return entry.content;
    },

    writeFile(path: any, data: any, options: any) {
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

    rename(oldPath: any, newPath: any) {
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

    stat(path: any) {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return {
        mtimeMs: entry.mtime || 0,
        isFile: () => true,
        isDirectory: () => false,
      };
    },

    readdir(dirPath: any) {
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

    open(_path: any, _flags: any, _mode: any) {
      throw new Error('open() not supported in browser adapter');
    },
    close() {
      throw new Error('close() not supported in browser adapter');
    },
    write() {
      throw new Error('write() not supported in browser adapter');
    },
    fsync() {
      throw new Error('fsync() not supported in browser adapter');
    },
    chmod() {
      // no-op in browser
    },
    realpath(path: any) {
      return path;
    },
    access() {
      // no-op — all file operations are permitted in-memory
    },
    utimes(_path: any, _atime: any, _mtime: any) {
      // no-op in browser
    },
    lstat(path: any) {
      return this.stat(path);
    },

    rmdir(_path: any) {
      // no-op in browser
    },

    rm(_path: any, _options: any) {
      // no-op in browser
    },

    mkdtemp(prefix: any) {
      return `${prefix}${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    },

    readlink(path: any) {
      return path;
    },

    appendFile(path: any, data: any, options: any) {
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

    appendFileAsync(path: any, data: any, options: any) {
      this.appendFile(path, data, options);
      return Promise.resolve();
    },

    createReadStream() {
      throw new Error('createReadStream() not supported in browser adapter');
    },

    createWriteStream() {
      throw new Error('createWriteStream() not supported in browser adapter');
    },

    flush,
  };

  return adapter;
}

export default createBrowserStorageAdapter
