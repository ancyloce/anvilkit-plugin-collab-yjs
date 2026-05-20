import { createNullBackend, type StorageBackend } from "./storage-backend.js";

const OBJECT_STORE_NAME = "updates";
const SEQUENCE_INDEX = "sequence";

export interface IndexedDbBackendOptions {
  readonly dbName: string;
  readonly schemaVersion: number;
  readonly mapName: string;
  readonly onFault?: (reason: string) => void;
}

/**
 * IndexedDB-backed durable queue for outbound Y.js updates. One object
 * store named `updates` per database; each row is `{ sequence: number,
 * payload: Uint8Array }`. The store is keyed by `sequence` (autoIncrement)
 * so insertion order is preserved across reads.
 *
 * Errors during `open()` (quota, schema mismatch, etc.) trigger a
 * silent downgrade to `NullBackend` so the rest of the adapter keeps
 * running. The `onFault` callback exposes the reason to the host for
 * telemetry / toast surfaces.
 */
export async function createIndexedDbBackend(
  options: IndexedDbBackendOptions,
): Promise<StorageBackend> {
  if (
    typeof globalThis === "undefined" ||
    typeof (globalThis as { indexedDB?: unknown }).indexedDB === "undefined"
  ) {
    options.onFault?.("indexed-db-unavailable");
    return createNullBackend();
  }

  let db: IDBDatabase | undefined;
  try {
    db = await openDatabase(options);
  } catch (error) {
    options.onFault?.(
      error instanceof Error ? error.message : "indexed-db-open-failed",
    );
    return createNullBackend();
  }

  // In-memory shadow of the size so `size()` can stay synchronous
  // (mirrors what the connection-status FSM expects).
  let cachedSize = 0;
  try {
    cachedSize = await countEntries(db);
  } catch {
    cachedSize = 0;
  }

  let downgraded = false;

  function downgrade(reason: string): void {
    if (downgraded) return;
    downgraded = true;
    options.onFault?.(reason);
    try {
      db?.close();
    } catch {
      // already closed
    }
    db = undefined;
  }

  return {
    async append(update: Uint8Array): Promise<void> {
      if (downgraded || !db) return;
      try {
        await runTransaction(db, "readwrite", (store) => {
          store.add({ payload: update });
        });
        cachedSize += 1;
      } catch (error) {
        downgrade(
          error instanceof Error ? error.message : "indexed-db-append-failed",
        );
      }
    },
    async drain(): Promise<readonly Uint8Array[]> {
      if (downgraded || !db) return [];
      try {
        // R1 — read and clear in ONE readwrite transaction via a
        // cursor so the set returned is exactly the set deleted.
        // The previous read-then-clear used two transactions; an
        // append() landing between them was wiped by clear()
        // without being returned (silent offline-edit loss).
        const all = await drainAtomic(db);
        cachedSize = 0;
        return all;
      } catch (error) {
        downgrade(
          error instanceof Error ? error.message : "indexed-db-drain-failed",
        );
        return [];
      }
    },
    async hydrate(): Promise<readonly Uint8Array[]> {
      if (downgraded || !db) return [];
      try {
        return await readAll(db);
      } catch (error) {
        downgrade(
          error instanceof Error ? error.message : "indexed-db-hydrate-failed",
        );
        return [];
      }
    },
    async compact(
      merge: (all: readonly Uint8Array[]) => Uint8Array | undefined,
    ): Promise<void> {
      if (downgraded || !db) return;
      try {
        // R2 — append-then-delete-by-key, never drain-then-append.
        // Snapshot the exact rows, fold them, COMMIT the merged
        // blob, and only then delete the snapshotted source keys.
        // A crash after the append commit but before the delete
        // leaves merged + originals (a safe superset under
        // commutative/idempotent applyUpdateV2), never an empty
        // store. Rows appended concurrently have higher sequence
        // keys and are outside the deleted set, so they survive.
        const rows = await readAllWithKeys(db);
        if (rows.length <= 1) return;
        const merged = merge(rows.map((row) => row.payload));
        if (merged === undefined) return;
        await runTransaction(db, "readwrite", (store) => {
          store.add({ payload: merged });
        });
        cachedSize += 1;
        await runTransaction(db, "readwrite", (store) => {
          for (const row of rows) store.delete(row.sequence);
        });
        cachedSize = Math.max(0, cachedSize - rows.length);
      } catch (error) {
        downgrade(
          error instanceof Error ? error.message : "indexed-db-compact-failed",
        );
      }
    },
    size(): number {
      return cachedSize;
    },
    destroy(): void {
      try {
        db?.close();
      } catch {
        // already closed
      }
      db = undefined;
    },
  };
}

function openDatabase(options: IndexedDbBackendOptions): Promise<IDBDatabase> {
  const idb = (globalThis as { indexedDB: IDBFactory }).indexedDB;
  const fullDbName = `${options.dbName}:${options.mapName}`;
  return new Promise((resolve, reject) => {
    const request = idb.open(fullDbName, options.schemaVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        const store = db.createObjectStore(OBJECT_STORE_NAME, {
          keyPath: SEQUENCE_INDEX,
          autoIncrement: true,
        });
        store.createIndex(SEQUENCE_INDEX, SEQUENCE_INDEX, { unique: true });
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("indexed-db-open-blocked-by-other-connection"));
    request.onsuccess = () => {
      const db = request.result;
      if (db.version > options.schemaVersion) {
        db.close();
        reject(new Error("indexed-db-schema-newer-than-shipped"));
        return;
      }
      resolve(db);
    };
  });
}

function runTransaction(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OBJECT_STORE_NAME, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("indexed-db-tx-aborted"));
    body(tx.objectStore(OBJECT_STORE_NAME));
  });
}

function countEntries(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OBJECT_STORE_NAME, "readonly");
    const request = tx.objectStore(OBJECT_STORE_NAME).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readAll(db: IDBDatabase): Promise<readonly Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OBJECT_STORE_NAME, "readonly");
    const request = tx.objectStore(OBJECT_STORE_NAME).getAll();
    request.onsuccess = () => {
      const rows = request.result as Array<{
        sequence: number;
        payload: Uint8Array;
      }>;
      rows.sort((left, right) => left.sequence - right.sequence);
      resolve(rows.map((row) => row.payload));
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * R2 — read every row WITH its `sequence` key (readonly), sorted by
 * insertion order, so `compact()` can delete exactly the rows it
 * folded and leave any concurrently-appended (higher-sequence) row
 * untouched.
 */
function readAllWithKeys(
  db: IDBDatabase,
): Promise<readonly { sequence: number; payload: Uint8Array }[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OBJECT_STORE_NAME, "readonly");
    const request = tx.objectStore(OBJECT_STORE_NAME).getAll();
    request.onsuccess = () => {
      const rows = request.result as Array<{
        sequence: number;
        payload: Uint8Array;
      }>;
      rows.sort((left, right) => left.sequence - right.sequence);
      resolve(rows);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * R1 — atomic read-then-clear. Walks a cursor inside a single
 * `readwrite` transaction, collecting each row's payload and deleting
 * that row in the same transaction. The set resolved is therefore
 * exactly the set removed: a concurrent `append()` either commits
 * before this transaction (its row is read and deleted) or after it
 * (its row survives untouched) — it can never be cleared without being
 * returned. Resolves on `tx.oncomplete` so the durable delete is
 * committed before the caller treats the queue as drained. Rows are
 * keyed by the autoincrement `sequence`, so cursor order is insertion
 * order; the explicit sort is a defensive backstop.
 */
function drainAtomic(db: IDBDatabase): Promise<readonly Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OBJECT_STORE_NAME, "readwrite");
    const rows: Array<{ sequence: number; payload: Uint8Array }> = [];
    const request = tx.objectStore(OBJECT_STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        rows.push(cursor.value as { sequence: number; payload: Uint8Array });
        cursor.delete();
        cursor.continue();
      }
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("indexed-db-tx-aborted"));
    tx.oncomplete = () => {
      rows.sort((left, right) => left.sequence - right.sequence);
      resolve(rows.map((row) => row.payload));
    };
  });
}
