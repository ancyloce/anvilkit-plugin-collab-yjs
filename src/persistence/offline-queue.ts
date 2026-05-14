import type { StorageBackend } from "./storage-backend.js";

export interface OfflineQueue {
	append(update: Uint8Array): void;
	drain(): Promise<readonly Uint8Array[]>;
	hydrate(): Promise<readonly Uint8Array[]>;
	size(): number;
	destroy(): void;
}

export interface OfflineQueueOptions {
	/**
	 * The current backend accessor — invoked lazily so callers that
	 * resolve the backend asynchronously can swap in the real
	 * implementation later. Defaults to `() => backend` when constructed
	 * with the legacy single-argument form.
	 */
	readonly getBackend: () => StorageBackend;
	/**
	 * Resolves once the underlying backend is ready to accept writes.
	 * Writes issued before this resolves are buffered in memory and
	 * flushed to the real backend on resolution. Without this option,
	 * the queue assumes the backend is already ready and writes
	 * pass-through immediately.
	 */
	readonly ready?: Promise<unknown>;
}

/**
 * Thin wrapper around `StorageBackend` that adapts the async backend
 * to the synchronous call-site at `doc.on("updateV2", ...)`. Writes
 * fire-and-forget through `backend.append` — failures are surfaced via
 * the backend's `onFault` callback (no exception escapes the Y.Doc
 * observer).
 *
 * When `ready` is provided, writes issued before the backend
 * resolves are buffered in memory and flushed once the backend is
 * ready. `size()` reflects the in-memory buffer plus the backend
 * count.
 */
export function createOfflineQueue(input: OfflineQueueOptions): OfflineQueue {
	const pendingAppends: Uint8Array[] = [];
	let ready = input.ready === undefined;
	if (input.ready) {
		void input.ready.then(() => {
			ready = true;
			const backend = input.getBackend();
			for (const update of pendingAppends) void backend.append(update);
			pendingAppends.length = 0;
		});
	}

	return {
		append(update: Uint8Array): void {
			if (!ready) {
				pendingAppends.push(update);
				return;
			}
			// Fire-and-forget: the backend swallows quota errors and
			// downgrades to NullBackend internally so we never throw out
			// of the Y.Doc observer chain.
			void input.getBackend().append(update);
		},
		drain(): Promise<readonly Uint8Array[]> {
			return input.getBackend().drain();
		},
		hydrate(): Promise<readonly Uint8Array[]> {
			return input.getBackend().hydrate();
		},
		size(): number {
			return pendingAppends.length + input.getBackend().size();
		},
		destroy(): void {
			input.getBackend().destroy();
			pendingAppends.length = 0;
		},
	};
}
