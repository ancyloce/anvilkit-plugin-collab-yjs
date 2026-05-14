/**
 * Storage backend contract for the L5 offline queue. Backends store
 * raw Y.js `updateV2` payloads (Uint8Array) keyed by a monotonically-
 * increasing sequence. `drain()` returns every queued entry in
 * insertion order and atomically clears the store on success.
 *
 * Two implementations ship with the plugin:
 *
 * - `IndexedDbBackend` — durable, cross-tab readable, persists across
 *   page reloads.
 * - `NullBackend` — no-op fallback used when IndexedDB is unavailable,
 *   when the host opts out, or after a quota / schema-mismatch fault
 *   forces a downgrade mid-session.
 */
export interface StorageBackend {
	/**
	 * Append one Y.js update payload to the durable queue. Returns once
	 * the backend has accepted the write — for IDB this means the put()
	 * resolved; for the null backend this is synchronous.
	 *
	 * Implementations MUST NOT throw on quota errors — they must signal
	 * the failure via the `onFault` callback and downgrade subsequent
	 * writes to no-ops. Throwing would poison the Y.Doc observer.
	 */
	append(update: Uint8Array): Promise<void>;

	/**
	 * Read every queued update in insertion order, then atomically
	 * clear the store. Used on reconnect to flush the offline queue
	 * back into the live Y.Doc.
	 */
	drain(): Promise<readonly Uint8Array[]>;

	/**
	 * Read every queued update without clearing the store. Used on
	 * adapter construction to hydrate the Y.Doc with leftover updates
	 * from a prior session before the first `subscribe()` fires.
	 */
	hydrate(): Promise<readonly Uint8Array[]>;

	/** Current number of entries in the store. Synchronous best-effort. */
	size(): number;

	/** Release any underlying handles (IDB connection, in-memory state). */
	destroy(): void;
}

/**
 * No-op backend. Used when IndexedDB is unavailable, when persistence
 * is disabled, or as the post-fault downgrade target so the rest of
 * the adapter keeps running without a durable queue.
 */
export function createNullBackend(): StorageBackend {
	return {
		async append(): Promise<void> {
			// no-op
		},
		async drain(): Promise<readonly Uint8Array[]> {
			return [];
		},
		async hydrate(): Promise<readonly Uint8Array[]> {
			return [];
		},
		size(): number {
			return 0;
		},
		destroy(): void {
			// no-op
		},
	};
}
