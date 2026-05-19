import type { PageIR } from "@anvilkit/core/types";
import {
	diffIR,
	type PeerInfo,
	type SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import * as Y from "yjs";

import type { ConflictModule } from "./conflicts.js";
import { decodeIR, encodeIR, hashIR } from "./encode.js";
import {
	SnapshotCorruptedError,
	SnapshotNotFoundError,
	SnapshotPrunedError,
} from "./snapshot-errors.js";
import type { LiveIRState } from "./live-ir.js";
import { nowMs } from "./metrics.js";
import {
	LAST_PEER_KEY,
	LEGACY_SNAPSHOT_INDEX_KEY,
	PAGE_IR_KEY,
	SNAPSHOT_META_PREFIX,
	snapshotMetaKey,
	snapshotPayloadKey,
} from "./keys.js";
import type { MetricsState } from "./metrics.js";
import {
	applyChangedNodesToNativeTree,
	applyIRToNativeTree,
	diffIRNodesForLocalSave,
	NATIVE_VERSION_KEY,
	readNativeTree,
} from "./native-tree.js";
import { validatePeerInfo } from "./presence-schema.js";
import type {
	ConnectionStatus,
	RemoteAwareSubscriber,
	RemoteChange,
} from "./types.js";

export interface SnapshotsModuleOptions {
	readonly doc: Y.Doc;
	readonly map: Y.Map<string>;
	readonly treeRoot: Y.Map<unknown> | undefined;
	readonly localPeer: PeerInfo;
	readonly metrics: MetricsState;
	readonly conflicts: ConflictModule;
	readonly liveIR: LiveIRState;
	readonly getCurrentStatus: () => ConnectionStatus;
	readonly computeDelta: boolean;
	/**
	 * I2 — retained-snapshot ceiling. `<= 0` disables the cap. See
	 * {@link CreateYjsAdapterOptions.maxSnapshots}.
	 */
	readonly maxSnapshots: number;
}

/**
 * Native-tree mode no longer mirrors the whole document into the legacy
 * `PAGE_IR_KEY` blob on every edit (H3) — that O(document) write is
 * what made keystroke-level saves non-incremental. The blob is instead
 * refreshed at most once per this interval (a "checkpoint") plus on the
 * first save and on `forceResync`, so cold-join readers, the
 * degraded-decode fallback, and any legacy-shaped reader stay current
 * within a bounded staleness. The native tree itself is updated
 * incrementally every save and is the real source of truth.
 *
 * Accuracy note (I9 / P1 / P2): the remote *read* path (`live-ir.ts`)
 * is incremental, including reorder/insert/delete (P1 relink — no
 * whole-document re-parse fan-out). The Y.Doc *apply* is O(changed)
 * (P1: `applyChangedNodesToNativeTree` for every non-first save), and
 * the save-time *classification* is one content hash per next-node
 * instead of stringifying every node twice (P2 — `diffIRNodesFor-
 * LocalSave` consumes the live-IR per-node hash cache). The remaining
 * O(document) floor per save is inherent: `encodeIR(ir)` produces the
 * snapshot *payload* string that is stored every save, and the
 * next-side hashing is itself O(document). Reducing that further
 * needs Puck-side change tracking the plugin does not have from
 * `onDataChange`; it stays deferred (I1) and gated by
 * `pnpm bench:collab-highload`. Snapshot storage is bounded by
 * {@link CreateYjsAdapterOptions.maxSnapshots} (I2).
 */
const BLOB_CHECKPOINT_MS = 5000;

export interface SnapshotsModule {
	save(ir: PageIR, meta: Partial<Omit<SnapshotMeta, "id" | "savedAt">>): string;
	list(): readonly SnapshotMeta[];
	load(id: string): PageIR;
	delete(id: string): void;
	forceResync(): Promise<PageIR | null>;
	readCurrentIR(): PageIR | undefined;
	readLastPeer(): PeerInfo | undefined;
	getLastLocalSavedAt(): number | undefined;
	getQueuedEdits(): number;
	resetQueuedEdits(): void;
	emitToSubscribers(ir: PageIR, peer?: PeerInfo, changed?: RemoteChange): void;
	subscribe(onUpdate: RemoteAwareSubscriber): () => void;
}

/**
 * Snapshot CRUD + subscriber registry. Owns:
 *
 * - `lastLocalSavedAt` — latency telemetry source (recorded by the
 *   metrics module).
 * - `queuedEdits` — count of saves since the last `synced` transition
 *   (M1). Substituted into outgoing offline events by the
 *   connection-status module.
 * - `subscribeListeners` — fan-out for remote-IR dispatch.
 *
 * Save() writes both the legacy `pageIR` blob and (when opted in) the
 * native Y.Map tree so the contract surface stays identical regardless
 * of encoding mode.
 */
export function createSnapshots(
	options: SnapshotsModuleOptions,
): SnapshotsModule {
	const {
		doc,
		map,
		treeRoot,
		localPeer,
		metrics,
		conflicts,
		liveIR,
		getCurrentStatus,
		computeDelta,
		maxSnapshots,
	} = options;
	const subscribeListeners = new Set<RemoteAwareSubscriber>();
	let lastLocalSavedAt: number | undefined;
	let lastBlobCheckpointAt: number | undefined;
	let queuedEdits = 0;
	// R3 — ids this session evicted via the maxSnapshots cap, so a later
	// load() of an id that is simply gone can be classified as "pruned
	// by retention" rather than "never existed". Bounded (insertion-
	// ordered Set, oldest dropped) so it can't grow without limit.
	const prunedIds = new Set<string>();
	const PRUNED_ID_MEMORY = 1024;
	function rememberPruned(id: string): void {
		prunedIds.add(id);
		if (prunedIds.size > PRUNED_ID_MEMORY) {
			const oldest = prunedIds.values().next().value;
			if (oldest !== undefined) prunedIds.delete(oldest);
		}
	}

	function readCurrentIR(): PageIR | undefined {
		if (treeRoot) {
			const fromTree = readNativeTree(treeRoot);
			if (fromTree) return fromTree;
			// Native tree was opted in but failed to decode despite
			// holding tree data — fall back to the legacy `pageIR` JSON
			// blob and flag the adapter as degraded so hosts can surface
			// the regression. An empty tree (no version key set yet) is
			// the normal pre-hydration state and is NOT flagged.
			if (treeRoot.has(NATIVE_VERSION_KEY)) {
				metrics.setDegraded(true, "decode-failure");
			}
		}
		const raw = map.get(PAGE_IR_KEY);
		if (typeof raw !== "string") return undefined;
		try {
			return decodeIR(raw);
		} catch {
			return undefined;
		}
	}

	function emitToSubscribers(
		ir: PageIR,
		peer?: PeerInfo,
		changed?: RemoteChange,
	): void {
		for (const listener of subscribeListeners) {
			try {
				listener(ir, peer, changed);
			} catch {
				metrics.incDispatchFailure();
			}
		}
	}

	return {
		save(ir, meta): string {
			const encodeStart = nowMs();
			const encoded = encodeIR(ir);
			const pageIRHash = meta.pageIRHash ?? hashIR(encoded);
			metrics.recordTiming("saveEncode", nowMs() - encodeStart);
			// L2 — compute the structural diff against the previously
			// saved IR (or against the empty document for the first
			// save). Captured BEFORE conflicts.noteLocalSave() advances
			// `lastLocalIR` to the new IR.
			let delta: SnapshotMeta["delta"];
			if (computeDelta || meta.delta !== undefined) {
				const previous = conflicts.getLastLocalIR();
				delta =
					meta.delta ??
					(previous === undefined
						? diffIR(EMPTY_IR, ir)
						: diffIR(previous, ir));
			}
			const snapshotMeta: SnapshotMeta = {
				id: metrics.createSnapshotId(),
				label: meta.label,
				savedAt: new Date().toISOString(),
				pageIRHash,
				...(delta !== undefined ? { delta } : {}),
			};
			const now = Date.now();
			// H3 — in native-tree mode the tree is the source of truth
			// and is updated incrementally every save. The legacy blob
			// is only refreshed on the first save, on a throttled
			// checkpoint cadence, or never (it stays a snapshot-only
			// concern). In legacy mode the blob IS the live state, so it
			// is written every save exactly as before.
			const writeBlob =
				!treeRoot ||
				lastBlobCheckpointAt === undefined ||
				now - lastBlobCheckpointAt >= BLOB_CHECKPOINT_MS;
			// I1/§3.1 — classify this save BEFORE the transaction (pure,
			// no Y.Doc ops). A non-structural save touches only a few
			// nodes; writing just those is byte-identical to the full
			// `applyIRToNativeTree` (unchanged nodes' `writeNode` is a
			// no-op) but O(changed) instead of O(document). Structural
			// saves (first save, topology change) keep the full apply.
			const prevLocalIR = conflicts.getLastLocalIR();
			// P2 — the live-IR cache holds the prev-side per-node content
			// hashes (in sync with `prevLocalIR`), so the classification
			// is one hash per next-node instead of stringifying every
			// node twice per keystroke.
			const localDiff = treeRoot
				? diffIRNodesForLocalSave(prevLocalIR, ir, liveIR.getNodeHashes())
				: undefined;
			doc.transact(() => {
				map.set(snapshotPayloadKey(snapshotMeta.id), encoded);
				map.set(snapshotMetaKey(snapshotMeta.id), JSON.stringify(snapshotMeta));
				// I2 — bound the retained snapshot set. Every keystroke
				// `save()` appended a full-document payload+meta to the
				// shared Y.Doc with no pruning → O(saves × doc) growth
				// (OOM, bloated sync; see the high-load report's 5.6 GB
				// RSS). Evict the oldest payload+meta beyond the ceiling
				// in this SAME transaction so the bound is a hard
				// invariant of the CRDT, not a consumer responsibility.
				// `forceResync`/cold-join keep working: the newest
				// snapshot (and the native tree) are always retained;
				// only ancient history is dropped. `<= 0` disables.
				if (maxSnapshots > 0) {
					const metas = readSnapshotMetas(map);
					const overflow = metas.length - maxSnapshots;
					for (let i = 0; i < overflow; i += 1) {
						const victim = metas[i];
						if (!victim) break;
						map.delete(snapshotPayloadKey(victim.id));
						map.delete(snapshotMetaKey(victim.id));
						rememberPruned(victim.id);
					}
				}
				if (treeRoot) {
					const applyStart = nowMs();
					if (localDiff !== undefined && !localDiff.structural) {
						applyChangedNodesToNativeTree(
							treeRoot,
							ir,
							prevLocalIR,
							localDiff.changed,
							localDiff.baseline,
							localDiff.removed,
						);
					} else {
						applyIRToNativeTree(treeRoot, ir, prevLocalIR);
					}
					metrics.recordTiming("nativeApply", nowMs() - applyStart);
				}
				if (writeBlob) map.set(PAGE_IR_KEY, encoded);
				// LAST_PEER_KEY is written every save (cheap, single
				// peer JSON) so remote observers can attribute the
				// authoring peer even when the blob is not refreshed.
				map.set(LAST_PEER_KEY, JSON.stringify(localPeer));
			}, localPeer);
			if (writeBlob) lastBlobCheckpointAt = now;
			// Keep the in-memory live view exactly in sync with what was
			// just written so remote observers never reconstruct the
			// whole tree just to learn current state (H3).
			if (treeRoot) {
				if (localDiff !== undefined && !localDiff.structural) {
					liveIR.setLocalChanged(ir, localDiff.changed, localDiff.removed);
				} else {
					liveIR.setLocal(ir);
				}
			}
			conflicts.noteLocalSave(ir);
			lastLocalSavedAt = Date.now();
			metrics.incSaveCount();
			if (getCurrentStatus().kind !== "synced") queuedEdits += 1;
			return snapshotMeta.id;
		},
		list(): readonly SnapshotMeta[] {
			return readSnapshotMetas(map);
		},
		load(id: string): PageIR {
			const exists = readSnapshotMetas(map).some((meta) => meta.id === id);
			if (!exists) {
				// Gone entirely. Retention deletes meta+payload in ONE Yjs
				// transaction, so the deterministic pruned signal is the
				// id being absent. `prunedIds` records evictions THIS
				// session did, so a same-session/local history UI gets the
				// precise `SnapshotPrunedError`. Cross-peer or post-reload
				// the eviction is not observable from this replica — the
				// id is simply unknown — so it surfaces as
				// `SnapshotNotFoundError` (best-effort by design; the host
				// can pre-filter against the retained `list()` to avoid
				// requesting ids below the retention floor).
				if (prunedIds.has(id)) {
					throw new SnapshotPrunedError(
						id,
						`plugin-collab-yjs: snapshot "${id}" was pruned by the maxSnapshots retention cap`,
					);
				}
				throw new SnapshotNotFoundError(
					id,
					`plugin-collab-yjs: no snapshot with id "${id}" in the shared Y.Doc`,
				);
			}
			const irRaw = map.get(snapshotPayloadKey(id));
			if (typeof irRaw !== "string") {
				// Meta present but payload missing. `load()` is synchronous
				// and retention deletes meta+payload atomically in one
				// transaction, so a concurrent prune cannot interleave
				// between these two reads — this is an inconsistent /
				// corrupt snapshot record, not a retention eviction.
				throw new SnapshotCorruptedError(
					id,
					`plugin-collab-yjs: snapshot "${id}" metadata present but payload missing — inconsistent/corrupt record`,
				);
			}
			try {
				return decodeIR(irRaw);
			} catch (error) {
				throw new SnapshotCorruptedError(
					id,
					`plugin-collab-yjs: failed to decode snapshot "${id}" — payload is corrupted or schema-drifted`,
					{ cause: error },
				);
			}
		},
		delete(id: string): void {
			doc.transact(() => {
				map.delete(snapshotPayloadKey(id));
				map.delete(snapshotMetaKey(id));
			}, localPeer);
		},
		async forceResync(): Promise<PageIR | null> {
			const metas = readSnapshotMetas(map);
			const latest = metas[metas.length - 1];
			if (!latest) return null;
			const irRaw = map.get(snapshotPayloadKey(latest.id));
			if (typeof irRaw !== "string") return null;
			const restored = decodeIR(irRaw);
			doc.transact(() => {
				if (treeRoot) {
					const applyStart = nowMs();
					applyIRToNativeTree(treeRoot, restored, conflicts.getLastLocalIR());
					metrics.recordTiming("nativeApply", nowMs() - applyStart);
				}
				// forceResync is an explicit authoritative re-emit —
				// always refresh the blob and reset the checkpoint clock
				// so cold/legacy readers immediately converge.
				map.set(PAGE_IR_KEY, irRaw);
				map.set(LAST_PEER_KEY, JSON.stringify(localPeer));
			}, localPeer);
			lastBlobCheckpointAt = Date.now();
			if (treeRoot) liveIR.setLocal(restored);
			conflicts.setLastLocalIR(restored);
			lastLocalSavedAt = Date.now();
			conflicts.closeWindow();
			for (const listener of subscribeListeners) {
				try {
					listener(restored, localPeer);
				} catch {
					// listener errors must not block resync from completing.
				}
			}
			return restored;
		},
		readCurrentIR,
		readLastPeer(): PeerInfo | undefined {
			const raw = map.get(LAST_PEER_KEY);
			if (typeof raw !== "string") return undefined;
			try {
				const parsed: unknown = JSON.parse(raw);
				return validatePeerInfo(parsed) ?? undefined;
			} catch {
				return undefined;
			}
		},
		getLastLocalSavedAt(): number | undefined {
			return lastLocalSavedAt;
		},
		getQueuedEdits(): number {
			return queuedEdits;
		},
		resetQueuedEdits(): void {
			queuedEdits = 0;
		},
		emitToSubscribers,
		subscribe(onUpdate): () => void {
			subscribeListeners.add(onUpdate);
			return () => {
				subscribeListeners.delete(onUpdate);
			};
		},
	};
}

function readSnapshotMetas(map: Y.Map<string>): readonly SnapshotMeta[] {
	const metas: SnapshotMeta[] = [];
	map.forEach((raw, key) => {
		if (!key.startsWith(SNAPSHOT_META_PREFIX)) return;
		const meta = parseSnapshotMeta(raw);
		if (meta) metas.push(meta);
	});

	if (metas.length > 0) {
		return metas.sort(compareSnapshotMeta);
	}

	return readLegacySnapshotIndex(map);
}

function readLegacySnapshotIndex(map: Y.Map<string>): readonly SnapshotMeta[] {
	const raw = map.get(LEGACY_SNAPSHOT_INDEX_KEY);
	if (typeof raw !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isSnapshotMeta).sort(compareSnapshotMeta);
	} catch {
		return [];
	}
}

function parseSnapshotMeta(raw: string): SnapshotMeta | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		return isSnapshotMeta(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function compareSnapshotMeta(left: SnapshotMeta, right: SnapshotMeta): number {
	const bySavedAt = left.savedAt.localeCompare(right.savedAt);
	return bySavedAt === 0 ? left.id.localeCompare(right.id) : bySavedAt;
}

function isSnapshotMeta(value: unknown): value is SnapshotMeta {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as {
		id?: unknown;
		label?: unknown;
		pageIRHash?: unknown;
		savedAt?: unknown;
		delta?: unknown;
	};
	return (
		typeof candidate.id === "string" &&
		(candidate.label === undefined || typeof candidate.label === "string") &&
		typeof candidate.pageIRHash === "string" &&
		typeof candidate.savedAt === "string" &&
		(candidate.delta === undefined || Array.isArray(candidate.delta))
	);
}

const EMPTY_IR: PageIR = {
	version: "1",
	root: { id: "__empty__", type: "__empty__", props: {} },
	assets: [],
	metadata: {},
};
