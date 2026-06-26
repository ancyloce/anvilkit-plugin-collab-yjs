import type { PageIR } from "@anvilkit/core/types";
import {
	diffIR,
	type PeerInfo,
	type SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import * as Y from "yjs";
import type {
	ConnectionStatus,
	PropGuardOptions,
	RemoteAwareSubscriber,
	RemoteChange,
	SnapshotPersistenceOptions,
} from "../types/types.js";
import type { ConflictModule } from "./conflicts.js";
import { decodeIR, encodeIR, hashIR } from "./encode.js";
import {
	LAST_PEER_KEY,
	LEGACY_SNAPSHOT_INDEX_KEY,
	PAGE_IR_KEY,
	SNAPSHOT_META_PREFIX,
	snapshotMetaKey,
	snapshotPayloadKey,
} from "./keys.js";
import type { LiveIRState } from "./live-ir.js";
import type { MetricsState } from "./metrics.js";
import { nowMs } from "./metrics.js";
import {
	applyChangedNodesToNativeTree,
	applyIRToNativeTree,
	diffIRNodesForLocalSave,
	NATIVE_VERSION_KEY,
	readNativeTree,
} from "./native-tree.js";
import {
	buildDeltaPayload,
	decodePayload,
	encodePayload,
	KEYFRAME_INTERVAL,
	type PayloadBackend,
	reconstructPayload,
	type StoredPayload,
} from "./payload-chain.js";
import { validatePeerInfo } from "./presence-schema.js";
import {
	SnapshotCorruptedError,
	SnapshotNotFoundError,
	SnapshotPrunedError,
} from "./snapshot-errors.js";

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
	/**
	 * Y3/§4.1.3 — per-prop decode bounds forwarded to the native-tree
	 * read in `readCurrentIR` so the checkpoint/cold-join decode path is
	 * bounded too. Omit to use the permissive defaults.
	 */
	readonly propGuards?: PropGuardOptions;
	/**
	 * §4.2.2 — optional server-grade snapshot persistence sink. When
	 * supplied, `save` mirrors each snapshot (meta + a self-contained
	 * encoded payload) and `delete` removes it; the in-`Y.Doc` store is
	 * unchanged and remains the default. Omit for the pre-§4.2.2 behavior.
	 */
	readonly snapshotPersistence?: SnapshotPersistenceOptions;
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
	loadPersistedSnapshot(id: string): Promise<PageIR | undefined>;
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
		propGuards,
		snapshotPersistence,
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

	// I1 — deltas chained since the last full keyframe. The snapshot
	// payload is stored as a keyframe every KEYFRAME_INTERVAL saves and a
	// small delta in between (see ./payload-chain), so the shared Y.Doc no
	// longer grows O(saves × document). Reconstruction walks back to the
	// nearest keyframe, so this also bounds chain depth.
	let savesSinceKeyframe = 0;
	// A `Y.Map`-backed view the delta-chain reconstruct/re-root logic reads
	// through. `orderedIds` is the canonical save order (also used for
	// keyframe spacing and eviction re-rooting).
	const payloadBackend: PayloadBackend = {
		read(id) {
			const raw = map.get(snapshotPayloadKey(id));
			if (typeof raw !== "string") return undefined;
			return decodePayload(raw);
		},
		write(id, payload) {
			map.set(snapshotPayloadKey(id), encodePayload(payload));
		},
		orderedIds() {
			return readSnapshotMetas(map).map((meta) => meta.id);
		},
	};

	function readCurrentIR(): PageIR | undefined {
		if (treeRoot) {
			const fromTree = readNativeTree(treeRoot, {
				onGuardTrip: (reason) => metrics.setDegraded(true, reason),
				propGuards,
			});
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

	// §4.2.2 — best-effort mirror of a backend snapshot-persistence call.
	// A backend fault NEVER propagates into the in-Y.Doc save/delete path
	// (which already completed and is the source of truth); it surfaces
	// only through the host's `onFault` sink. Synchronous throws and
	// rejected promises are both funneled here.
	function runMirror(operation: string, fn: () => void | Promise<void>): void {
		try {
			const result = fn();
			if (result instanceof Promise) {
				result.catch((error: unknown) => {
					snapshotPersistence?.onFault?.(operation, error);
				});
			}
		} catch (error) {
			snapshotPersistence?.onFault?.(operation, error);
		}
	}

	// §4.2.2 — encode a payload for the external backend: serialize, then
	// apply the optional encryption-at-rest transform. The in-Y.Doc copy
	// is written separately (untransformed) by `payloadBackend.write`.
	function encodeForMirror(payload: StoredPayload): string {
		const encoded = encodePayload(payload);
		return snapshotPersistence?.encode
			? snapshotPersistence.encode(encoded)
			: encoded;
	}

	// §4.2.2 — mirror a just-completed save to the backend. The external
	// record is always a self-contained KEYFRAME (the full IR) so a later
	// `loadPersistedSnapshot` never depends on the in-Y.Doc delta chain or
	// its bounded `maxSnapshots` retention window — the whole point of a
	// durable server-grade store.
	function mirrorSave(meta: SnapshotMeta, ir: PageIR): void {
		if (!snapshotPersistence) return;
		const payload = encodeForMirror({ kind: "full", ir });
		runMirror("saveSnapshot", () =>
			snapshotPersistence.adapter.saveSnapshot(meta, payload),
		);
	}

	// §4.2.2 — mirror an explicit `delete(id)` to the backend. Retention
	// evictions are deliberately NOT mirrored: the durable store is meant
	// to outlive the bounded in-Y.Doc window, so pruning ancient CRDT
	// history must not delete the backend's record of it.
	function mirrorDelete(id: string): void {
		if (!snapshotPersistence) return;
		runMirror("deleteSnapshot", () =>
			snapshotPersistence.adapter.deleteSnapshot(id),
		);
	}

	async function loadPersistedSnapshot(
		id: string,
	): Promise<PageIR | undefined> {
		if (!snapshotPersistence) return undefined;
		const stored = await snapshotPersistence.adapter.loadSnapshot(id);
		if (stored === undefined) return undefined;
		const decoded = snapshotPersistence.decode
			? snapshotPersistence.decode(stored)
			: stored;
		// §4.2.4 — a backend blob is fully untrusted: a corrupt/version-
		// drifted/transform-mismatched payload must surface as the typed
		// `SnapshotCorruptedError`, not leak a raw decode `Error`.
		let payload: StoredPayload;
		try {
			payload = decodePayload(decoded);
		} catch (error) {
			throw new SnapshotCorruptedError(
				id,
				`plugin-collab-yjs: persisted snapshot "${id}" failed to decode — payload is corrupted, version-drifted, or the decode transform did not match`,
				{ cause: error },
			);
		}
		// External payloads are always written as self-contained keyframes
		// (see `mirrorSave`), so a full payload is the expected shape.
		if (payload.kind === "full") return payload.ir;
		// Defensive: a non-keyframe blob cannot be reconstructed in
		// isolation from the backend (no base chain is mirrored).
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: persisted snapshot "${id}" is not a self-contained payload`,
		);
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
			// I1 — choose the payload encoding. A non-root-change save is
			// stored as a small DELTA built from the O(changed) `localDiff`
			// (changed nodes' own content + child ids, plus removed ids and
			// the page-level assets/metadata verbatim) against the previous
			// snapshot. A full KEYFRAME is written on the first save, in
			// legacy (no native tree) mode, on a structural (root-id) change,
			// or every KEYFRAME_INTERVAL-th save to bound reconstruction
			// depth. This replaces the previous full-document write per save
			// (O(saves × doc) CRDT growth). `load`/`forceResync` reconstruct.
			const prevSnapshotId = readSnapshotMetas(map).at(-1)?.id;
			let payload: StoredPayload = { kind: "full", ir };
			if (
				treeRoot !== undefined &&
				localDiff !== undefined &&
				!localDiff.structural &&
				prevSnapshotId !== undefined &&
				savesSinceKeyframe < KEYFRAME_INTERVAL
			) {
				payload = buildDeltaPayload({
					base: prevSnapshotId,
					ir,
					changed: localDiff.changed,
					removed: localDiff.removed,
				});
			}
			const isKeyframe = payload.kind === "full";
			doc.transact(() => {
				payloadBackend.write(snapshotMeta.id, payload);
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
					if (overflow > 0) {
						const victims = metas.slice(0, overflow);
						const victimIds = new Set(victims.map((m) => m.id));
						// Re-root before deleting: deltas chain linearly, so at
						// most the FIRST surviving snapshot can be a delta based
						// on an evicted one. Promote it to a self-contained
						// keyframe (reconstructed while the victim chain is still
						// present) so the bound stays a hard CRDT invariant and
						// no survivor is orphaned. Best-effort: a corrupt chain
						// here is left to surface as SnapshotCorrupted on load.
						for (const meta of metas.slice(overflow)) {
							try {
								const record = payloadBackend.read(meta.id);
								if (record?.kind === "delta" && victimIds.has(record.base)) {
									const full = reconstructPayload(payloadBackend, meta.id);
									payloadBackend.write(meta.id, { kind: "full", ir: full });
								}
							} catch {
								/* leave as-is; load() will report corruption */
							}
							break;
						}
						for (const victim of victims) {
							map.delete(snapshotPayloadKey(victim.id));
							map.delete(snapshotMetaKey(victim.id));
							rememberPruned(victim.id);
						}
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
			// Reset the keyframe counter when a full payload was written,
			// otherwise advance it so the next KEYFRAME_INTERVAL-th save
			// re-keyframes and reconstruction depth stays bounded.
			savesSinceKeyframe = isKeyframe ? 0 : savesSinceKeyframe + 1;
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
			// §4.2.2 — mirror the durable, self-contained snapshot to the
			// optional backend AFTER the authoritative in-Y.Doc write.
			mirrorSave(snapshotMeta, ir);
			return snapshotMeta.id;
		},
		list(): readonly SnapshotMeta[] {
			return readSnapshotMetas(map);
		},
		load(id: string): PageIR {
			// §4.2.4 — when a per-key metadata record exists for this id,
			// validate it STRICTLY first. A present-but-malformed record
			// (empty id, invalid savedAt timestamp, malformed delta op) is
			// corruption — reporting it as `SnapshotCorruptedError` is more
			// honest than letting the tolerant `readSnapshotMetas` drop it
			// and surfacing a misleading `SnapshotNotFoundError`.
			const rawMeta = map.get(snapshotMetaKey(id));
			if (typeof rawMeta === "string") {
				decodeSnapshotMetaStrict(rawMeta, id);
			}
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
				// Reconstruct via the delta-chain: keyframes return directly,
				// deltas replay back to the nearest keyframe (./payload-chain).
				return reconstructPayload(payloadBackend, id);
			} catch (error) {
				throw new SnapshotCorruptedError(
					id,
					`plugin-collab-yjs: failed to reconstruct snapshot "${id}" — payload/chain is corrupted or schema-drifted`,
					{ cause: error },
				);
			}
		},
		delete(id: string): void {
			doc.transact(() => {
				map.delete(snapshotPayloadKey(id));
				map.delete(snapshotMetaKey(id));
			}, localPeer);
			// §4.2.2 — mirror the explicit deletion to the optional backend.
			mirrorDelete(id);
		},
		loadPersistedSnapshot,
		async forceResync(): Promise<PageIR | null> {
			const metas = readSnapshotMetas(map);
			const latest = metas[metas.length - 1];
			if (!latest) return null;
			if (typeof map.get(snapshotPayloadKey(latest.id)) !== "string") {
				return null;
			}
			let restored: PageIR;
			try {
				restored = reconstructPayload(payloadBackend, latest.id);
			} catch {
				// Latest snapshot's chain is unreadable — nothing safe to
				// re-emit; surface as a no-op resync.
				return null;
			}
			// The blob must hold a canonical encoded IR (readCurrentIR
			// decodes it), so re-encode the reconstructed snapshot rather
			// than writing the raw delta/keyframe payload string.
			const restoredBlob = encodeIR(restored);
			doc.transact(() => {
				if (treeRoot) {
					const applyStart = nowMs();
					applyIRToNativeTree(treeRoot, restored, conflicts.getLastLocalIR());
					metrics.recordTiming("nativeApply", nowMs() - applyStart);
				}
				// forceResync is an explicit authoritative re-emit —
				// always refresh the blob and reset the checkpoint clock
				// so cold/legacy readers immediately converge.
				map.set(PAGE_IR_KEY, restoredBlob);
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
	// §4.2.4 — beyond the shallow shape: the id must be a non-empty
	// string, `savedAt` must parse to a finite, non-negative epoch, and a
	// present `delta` must be a well-formed IRDiff (each op a known kind
	// with the right primitive fields).
	return (
		isNonEmptyString(candidate.id) &&
		(candidate.label === undefined || typeof candidate.label === "string") &&
		typeof candidate.pageIRHash === "string" &&
		isValidSavedAt(candidate.savedAt) &&
		(candidate.delta === undefined || isValidIRDiff(candidate.delta))
	);
}

/**
 * §4.2.4 — strict counterpart to {@link isSnapshotMeta} for the targeted
 * `load(id)` read: instead of silently dropping a present-but-malformed
 * record (which would re-surface as a misleading not-found), it throws a
 * typed {@link SnapshotCorruptedError} naming the defect. Returns the
 * validated meta on success.
 */
function decodeSnapshotMetaStrict(raw: string, id: string): SnapshotMeta {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: snapshot "${id}" metadata is not valid JSON`,
			{ cause: error },
		);
	}
	if (!isObject(parsed)) {
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: snapshot "${id}" metadata is not an object`,
		);
	}
	if (!isNonEmptyString(parsed.id)) {
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: snapshot "${id}" metadata has an empty or non-string id`,
		);
	}
	if (typeof parsed.pageIRHash !== "string") {
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: snapshot "${id}" metadata has a non-string pageIRHash`,
		);
	}
	if (!isValidSavedAt(parsed.savedAt)) {
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: snapshot "${id}" metadata has an invalid savedAt timestamp`,
		);
	}
	if (parsed.label !== undefined && typeof parsed.label !== "string") {
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: snapshot "${id}" metadata has a non-string label`,
		);
	}
	if (parsed.delta !== undefined && !isValidIRDiff(parsed.delta)) {
		throw new SnapshotCorruptedError(
			id,
			`plugin-collab-yjs: snapshot "${id}" metadata carries a malformed delta operation`,
		);
	}
	return parsed as unknown as SnapshotMeta;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * A `SnapshotMeta.savedAt` is an ISO-8601 string; require it to parse to
 * a finite, non-negative epoch (snapshots are always post-1970), so a
 * garbage or non-finite timestamp is rejected as corruption.
 */
function isValidSavedAt(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && ms >= 0;
}

/** §4.2.4 — validate a `SnapshotMeta.delta` (an {@link IRDiff}). */
function isValidIRDiff(value: unknown): boolean {
	return Array.isArray(value) && value.every(isValidIRDiffOp);
}

/** §4.2.4 — validate one {@link IRDiffOp}: known kind + correct field types. */
function isValidIRDiffOp(value: unknown): boolean {
	if (!isObject(value)) return false;
	switch (value.kind) {
		case "add-node":
			return typeof value.path === "string" && isObject(value.node);
		case "remove-node":
			return typeof value.path === "string" && typeof value.nodeId === "string";
		case "move-node":
			return (
				typeof value.from === "string" &&
				typeof value.to === "string" &&
				typeof value.nodeId === "string"
			);
		case "change-prop":
			return typeof value.path === "string" && typeof value.key === "string";
		case "change-children":
			return (
				typeof value.path === "string" &&
				Array.isArray(value.before) &&
				Array.isArray(value.after) &&
				value.before.every((entry) => typeof entry === "string") &&
				value.after.every((entry) => typeof entry === "string")
			);
		case "meta-changed":
			return typeof value.path === "string" && typeof value.key === "string";
		default:
			return false;
	}
}

const EMPTY_IR: PageIR = {
	version: "1",
	root: { id: "__empty__", type: "__empty__", props: {} },
	assets: [],
	metadata: {},
};
