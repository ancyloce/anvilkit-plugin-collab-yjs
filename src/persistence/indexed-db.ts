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
				const all = await readAll(db);
				await runTransaction(db, "readwrite", (store) => {
					store.clear();
				});
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
