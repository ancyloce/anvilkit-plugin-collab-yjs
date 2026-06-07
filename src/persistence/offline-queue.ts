import * as Y from "yjs";

import type { StorageBackend } from "./storage-backend.js";

/**
 * Compact the durable queue once this many raw updates have been
 * appended since the last compaction (M6). A long offline session
 * otherwise accumulates one row per keystroke-level update; reconnect
 * then replays a huge un-compacted sequence and stalls. Merging with
 * `Y.mergeUpdatesV2` collapses the backlog to a single equivalent
 * update, bounding both replay length and stored bytes.
 */
const DEFAULT_COMPACT_EVERY = 200;

/**
 * Y1 — cap the in-memory pre-ready buffer. Writes issued before the backend
 * `ready` promise resolves are buffered; a stuck/slow backend open (quota full,
 * permission denied, a hung IndexedDB `open`) under keystroke-rate edits would
 * otherwise grow this without bound. On overflow we collapse the backlog into a
 * single equivalent update via `Y.mergeUpdatesV2` — lossless, the same merge
 * the durable compaction path uses — so memory stays bounded with no dropped
 * edits even if `ready` never resolves.
 */
const MAX_PENDING_APPENDS = 1024;

export interface OfflineQueue {
	append(update: Uint8Array): void;
	drain(): Promise<readonly Uint8Array[]>;
	/**
	 * M3 — crash-safe compaction: merge the queued backlog into a single
	 * equivalent update (append-then-delete) WITHOUT dropping unacked
	 * state. Called on reconnect/`synced` instead of a destructive
	 * `drain()`, so a crash before the server durably persists the
	 * replicated doc cannot lose the offline edits. No-op when compaction
	 * is disabled (`compactEvery: Infinity`).
	 */
	compact(): Promise<void>;
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
	/**
	 * Compact the durable queue after this many appends (M6). Defaults
	 * to 200. Set `Infinity` to disable compaction.
	 */
	readonly compactEvery?: number;
	/**
	 * Y1 — cap the in-memory pre-`ready` buffer. On overflow the backlog is
	 * losslessly merged into one update; defaults to {@link MAX_PENDING_APPENDS}.
	 * Primarily a test seam — production never sets it.
	 */
	readonly maxPendingAppends?: number;
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
	const compactEvery = input.compactEvery ?? DEFAULT_COMPACT_EVERY;
	const maxPendingAppends = Math.max(
		1,
		input.maxPendingAppends ?? MAX_PENDING_APPENDS,
	);
	let appendsSinceCompaction = 0;
	let compacting = false;
	let destroyed = false;

	async function compact(): Promise<void> {
		if (compacting || destroyed || !Number.isFinite(compactEvery)) return;
		compacting = true;
		try {
			// R2 — crash-safe: the backend appends the merged blob and
			// only then deletes the source rows (append-then-delete). A
			// crash mid-compaction leaves merged + originals (a safe
			// superset under commutative/idempotent applyUpdateV2), never
			// the empty store the old drain()-then-append() risked.
			await input
				.getBackend()
				.compact((all) =>
					all.length > 1 ? Y.mergeUpdatesV2(all.map((u) => u)) : all[0],
				);
		} catch {
			// Best-effort: a fault downgrades the backend to NullBackend
			// internally; losing the compaction pass is non-fatal.
		} finally {
			compacting = false;
		}
	}

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
				// Y1 — bound the buffer if the backend never becomes ready: merge
				// the backlog into one equivalent update instead of growing forever.
				if (pendingAppends.length > maxPendingAppends) {
					try {
						const merged = Y.mergeUpdatesV2(pendingAppends.map((u) => u));
						pendingAppends.length = 0;
						pendingAppends.push(merged);
					} catch {
						// Merge should never fail on real updateV2 payloads, but this
						// runs in the Y.Doc observer chain and must never throw — bound
						// memory by dropping the oldest half as a fallback.
						pendingAppends.splice(0, pendingAppends.length >> 1);
					}
				}
				return;
			}
			// Fire-and-forget: the backend swallows quota errors and
			// downgrades to NullBackend internally so we never throw out
			// of the Y.Doc observer chain.
			void input.getBackend().append(update);
			appendsSinceCompaction += 1;
			if (appendsSinceCompaction >= compactEvery) {
				appendsSinceCompaction = 0;
				void compact();
			}
		},
		drain(): Promise<readonly Uint8Array[]> {
			return input.getBackend().drain();
		},
		compact,
		hydrate(): Promise<readonly Uint8Array[]> {
			return input.getBackend().hydrate();
		},
		size(): number {
			return pendingAppends.length + input.getBackend().size();
		},
		destroy(): void {
			destroyed = true;
			input.getBackend().destroy();
			pendingAppends.length = 0;
		},
	};
}
