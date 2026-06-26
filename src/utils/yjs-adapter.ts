import type { PageIR } from "@anvilkit/core/types";
import type {
	PeerInfo,
	SnapshotMeta,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createPersistence } from "../persistence/index.js";
import type {
	CreateYjsAdapterOptions,
	MetricsSnapshot,
	RemoteChange,
	YjsSnapshotAdapter,
} from "../types/types.js";
import { InvalidAdapterOptionsError } from "./adapter-errors.js";
import { createAwarenessBridge } from "./awareness-bridge.js";
import { createConflicts } from "./conflicts.js";
import { createConnectionStatus } from "./connection-status.js";
import { decodeIR } from "./encode.js";
import { DEFAULT_MAP_NAME, LAST_PEER_KEY, PAGE_IR_KEY } from "./keys.js";
import { createLiveIRState } from "./live-ir.js";
import { createMetricsState, nowMs } from "./metrics.js";
import {
	applyIRToNativeTree,
	deriveChangedNodeIds,
	NATIVE_VERSION_KEY,
	readNativeTree,
} from "./native-tree.js";
import { validatePeerInfo } from "./presence-schema.js";
import { createSnapshots } from "./snapshots.js";

/**
 * Y4 — `Y.Transaction.changed` is keyed by the internal
 * `AbstractType<YEvent<…>>` shape, which Yjs's public types do not unify with a
 * concrete `Y.Map`. The one unavoidable cast lives here so a future Yjs release
 * that fixes the upstream typings has a single site to delete, rather than an
 * `as unknown as` buried in the observer hot path.
 */
function transactionTouchedType(
	transaction: Y.Transaction,
	type: Y.Map<unknown>,
): boolean {
	return transaction.changed.has(
		type as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>,
	);
}

/**
 * Build a SnapshotAdapter v2 backed by a shared Y.Doc.
 *
 * Encoding is intentionally simple for the alpha cycle: the latest
 * live PageIR is JSON-encoded under one Y.Map key, while saved
 * snapshots are stored under per-id metadata and payload keys. Yjs
 * gives last-writer-wins semantics to the live key with deterministic
 * conflict resolution, which is correct (eventually-consistent +
 * convergent) but coarse-grained.
 *
 * Internal structure (post-2026-05-13 split): the public factory
 * composes six focused modules:
 *
 * - `keys.ts` — magic-string Y.Map keys
 * - `metrics.ts` — saveCount, latency window, churn sliding window,
 *   degraded flag, snapshot id generator
 * - `connection-status.ts` — status FSM + queuedEdits injection
 * - `conflicts.ts` — overlap computation + unconfirmed-window tracking
 * - `snapshots.ts` — save/load/list/delete/forceResync + subscribers
 * - `awareness-bridge.ts` — presence + churn + presence-validation
 *
 * Each module owns its own state. The orchestrator wires them together
 * via callback dependencies and owns the Y.Map observer + Y.Map deep
 * tree observer registrations so `destroy()` can release both.
 */
export function createYjsAdapter(
	options: CreateYjsAdapterOptions,
): YjsSnapshotAdapter {
	// §4.2.4 — validate construction options at the trust boundary so a
	// misconfigured host fails fast (typed `InvalidAdapterOptionsError`)
	// instead of silently binding to a blank/wrong shared `Y.Map` or
	// attributing every local write to an id-less peer.
	const mapName = resolveMapName(options.mapName);
	const map = options.doc.getMap<string>(mapName);
	const awareness = options.awareness ?? new Awareness(options.doc);
	const localPeer: PeerInfo = resolveLocalPeer(options.peer);
	const staleAfterMs = options.staleAfterMs ?? 2000;
	// L1 — native-tree is the default encoding. Hosts can opt back into
	// the legacy whole-document JSON-blob mode by setting
	// `useNativeTree: false`. Native-tree gives per-node CRDT merge
	// semantics so disjoint concurrent edits both survive instead of
	// LWW-clobbering each other.
	const useNativeTree = options.useNativeTree ?? true;
	const treeRoot = useNativeTree
		? options.doc.getMap<unknown>(`${mapName}:tree`)
		: undefined;

	// L1 migration — if the tree is empty (no version key) but the
	// legacy `pageIR` JSON-blob holds a valid IR, materialize the tree
	// from it. One-shot, transactional, idempotent: subsequent adapters
	// constructed on the same doc short-circuit on the version-key
	// check. Failed decodes leave the tree empty so the next save() can
	// initialize it from the host's IR.
	if (treeRoot && !treeRoot.has(NATIVE_VERSION_KEY)) {
		const legacyRaw = map.get(PAGE_IR_KEY);
		if (typeof legacyRaw === "string") {
			try {
				const legacyIR = decodeIR(legacyRaw);
				options.doc.transact(() => {
					applyIRToNativeTree(treeRoot, legacyIR, undefined);
				}, localPeer);
			} catch {
				// Legacy blob unparseable — leave tree empty.
			}
		}
	}

	const metrics = createMetricsState();
	const conflicts = createConflicts(
		staleAfterMs,
		localPeer,
		options.resolveConflict,
	);
	// H3 — in-memory authoritative live IR. A guard trip (cycle, depth,
	// or node-count overflow from malformed/hostile remote tree data,
	// M4) degrades the adapter so hosts can surface the regression.
	const liveIR = createLiveIRState({
		onGuardTrip: (reason) => metrics.setDegraded(true, reason),
		propGuards: options.propGuards,
	});
	const persistence = createPersistence({
		options: options.persistence,
		mapName,
		onFault: options.persistence?.onFault,
	});
	const connectionStatus = createConnectionStatus({
		connectionSource: options.connectionSource,
		// L5 — when persistence is enabled, the queue depth is the
		// authoritative `queuedEdits` count (substituted into outbound
		// `offline` events). The in-memory snapshots counter remains
		// the fallback so adapters without persistence stay backward
		// compatible.
		getQueuedEdits: () =>
			persistence.hasDurableQueue
				? persistence.offlineQueue.size()
				: snapshots.getQueuedEdits(),
		onSynced: () => {
			snapshots.resetQueuedEdits();
			conflicts.closeWindow();
			// M3 — compact (merge) the offline backlog rather than
			// destructively draining it. `synced` is a connection/
			// initial-sync signal, NOT a server-persistence ack; the live
			// Y.Doc already carries the offline edits and replicates them
			// via sync, so the durable queue is reload-survival. A
			// `drain()` here deletes that survival copy before the server
			// has durably accepted the replicated state — a crash in that
			// window would lose the edits from both the queue and the
			// reloaded doc. `compact()` bounds replay length without
			// dropping unacked state. Best-effort: faults surface via
			// `persistence.options.onFault`.
			if (persistence.hasDurableQueue) {
				void persistence.offlineQueue.compact();
			}
		},
	});
	const snapshots = createSnapshots({
		doc: options.doc,
		map,
		treeRoot,
		localPeer,
		metrics,
		conflicts,
		liveIR,
		getCurrentStatus: () => connectionStatus.getStatus(),
		computeDelta: options.computeDelta ?? false,
		maxSnapshots: options.maxSnapshots ?? 200,
		propGuards: options.propGuards,
		snapshotPersistence: options.snapshotPersistence,
	});
	// Activate the host `connectionSource` subscription now that every
	// module its `emit` path reaches — `snapshots` (via `onSynced`/
	// `getQueuedEdits`), `conflicts`, `persistence` — is constructed.
	// `createConnectionStatus` deliberately does NOT subscribe in its
	// constructor: a source that emits its current state synchronously on
	// attach (the demo Hocuspocus BYO transport, the managed transport)
	// would otherwise run `onSynced` against `snapshots` before this point —
	// a temporal-dead-zone `ReferenceError` at `<Studio>` mount.
	connectionStatus.start();
	const awarenessBridge = createAwarenessBridge(
		awareness,
		metrics,
		options.awarenessRateLimit,
	);

	// Seed the conflict baseline from the already-loaded document.
	// `conflicts.noteLocalSave()` only anchors `baselineIR` from
	// `lastLocalIR`, which is otherwise undefined until the first remote
	// Yjs event or snapshot restore. The plugin-level hydrate path
	// (`dispatchRemoteIR`) does NOT touch the conflict module, so a
	// fresh session with existing document content but no remote edits
	// yet would take `propsConflict`'s divergence-as-conflict fallback
	// on the user's first save and mis-report disjoint concurrent edits
	// as overlaps. Anchoring `lastLocalIR` to the loaded state here puts
	// the first save on the three-way baseline path. A genuinely empty
	// doc reads back `undefined` and keeps the legacy first-save
	// semantics (the divergence fallback) untouched.
	{
		let loadedIR: PageIR | undefined;
		if (treeRoot && treeRoot.has(NATIVE_VERSION_KEY)) {
			loadedIR =
				readNativeTree(treeRoot, {
					onGuardTrip: (reason) => metrics.setDegraded(true, reason),
					propGuards: options.propGuards,
				}) ?? undefined;
		} else {
			const legacyRaw = map.get(PAGE_IR_KEY);
			if (typeof legacyRaw === "string") {
				try {
					loadedIR = decodeIR(legacyRaw);
				} catch {
					// Unparseable blob — leave the baseline unseeded.
				}
			}
		}
		if (loadedIR && conflicts.getLastLocalIR() === undefined) {
			conflicts.setLastLocalIR(loadedIR);
		}
	}

	function dispatchRemote(
		remoteIR: PageIR,
		peer: PeerInfo | undefined,
		changed?: RemoteChange,
	): void {
		const resolved = conflicts.maybeFire(remoteIR, peer);
		if (resolved !== undefined) {
			// §4.2.3 — a host `resolveConflict` hook chose a field-level
			// merge over pure last-write-wins. Re-base local tracking onto
			// the just-merged remote state FIRST so `save` diffs the
			// override against what is actually in the tree (the LWW
			// remote-wins value), then write the merge back: this overwrites
			// the remote value in the shared `Y.Doc` and replicates to every
			// peer. A local-origin save is filtered out of this observer, so
			// emit the merged IR to local subscribers explicitly to keep the
			// editor in sync with the doc.
			conflicts.setLastLocalIR(remoteIR);
			snapshots.save(resolved, {});
			conflicts.closeWindow();
			snapshots.emitToSubscribers(resolved, peer, changed);
			return;
		}
		conflicts.closeWindow();
		conflicts.setLastLocalIR(remoteIR);
		snapshots.emitToSubscribers(remoteIR, peer, changed);
	}

	// H3 — the native-tree deep observer is the PRIMARY remote-dispatch
	// path. Native-mode saves update the tree incrementally and no
	// longer rewrite the whole-document `PAGE_IR_KEY` blob every edit,
	// so keying remote detection off that blob would miss live edits.
	// The legacy `map.observe` below is now only a back-compat fallback
	// for transactions that touched `PAGE_IR_KEY` WITHOUT touching the
	// tree (old/legacy-mode writers, raw forceResync from a stale peer).
	const treeObserver = treeRoot
		? (
				events: Y.YEvent<Y.AbstractType<unknown>>[],
				transaction: Y.Transaction,
			) => {
				if (isLocalOrigin(transaction.origin, localPeer)) return;
				const { ids, structural, relink } = deriveChangedNodeIds(events);
				if (ids.size === 0 && !structural && relink === undefined) {
					return;
				}
				const savedAt = snapshots.getLastLocalSavedAt();
				if (savedAt !== undefined) metrics.recordObservationLatency(savedAt);
				// LAST_PEER_KEY is written by every save in the same
				// transaction as the tree write, so the latest value is
				// the authoring peer of this change.
				const peer = snapshots.readLastPeer();
				const readStart = nowMs();
				const remoteIR = liveIR.applyRemoteChangedNodes(
					treeRoot,
					ids,
					structural,
					relink,
				);
				metrics.recordTiming("nativeRead", nowMs() - readStart);
				if (!remoteIR) return;
				// Native-tree hot path: forward the change set the
				// observer already computed so the plugin can apply a
				// non-structural edit in O(changed) instead of
				// re-deriving it in O(document). `relink` (P1) lets the
				// plugin keep its proven full dispatch for a topology
				// change while the cache above stayed incremental.
				dispatchRemote(remoteIR, peer, { ids, structural, relink });
			}
		: undefined;
	if (treeRoot && treeObserver) treeRoot.observeDeep(treeObserver);

	const observer = (event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
		if (!event.changes.keys.has(PAGE_IR_KEY)) return;
		if (isLocalOrigin(transaction.origin, localPeer)) return;
		// When the native tree was touched in the same transaction the
		// deep observer already handled (and will emit) this update —
		// skip to avoid a double dispatch. Order-independent: we test
		// the transaction's changed-type set, not observer fire order.
		if (treeRoot && transactionTouchedType(transaction, treeRoot)) {
			return;
		}
		const savedAt = snapshots.getLastLocalSavedAt();
		if (savedAt !== undefined) metrics.recordObservationLatency(savedAt);
		const peer = event.changes.keys.has(LAST_PEER_KEY)
			? snapshots.readLastPeer()
			: undefined;
		// readCurrentIR preserves the legacy tree-then-blob fallback
		// (and the degraded-on-decode-failure flag). Sync the live cache
		// so a subsequent tree event reads incrementally from fresh
		// state rather than a stale snapshot.
		const remoteIR = snapshots.readCurrentIR();
		if (!remoteIR) return;
		if (treeRoot) liveIR.applyRemoteFullBlob(remoteIR);
		dispatchRemote(remoteIR, peer);
	};
	map.observe(observer);

	// L5 — outbound update wiring. `doc.on("updateV2")` fires for every
	// transaction, local or remote. We filter to local-origin and:
	//   - append to the offline queue (durable, survives reload)
	//   - post to BroadcastChannel (same-origin cross-tab)
	// Remote-origin transactions (including BroadcastChannel-applied
	// updates tagged with `BROADCAST_ORIGIN`) are skipped to avoid
	// echo loops.
	const updateHandler = (
		update: Uint8Array,
		origin: unknown,
		_doc: Y.Doc,
		_tx: Y.Transaction,
	) => {
		if (origin === BROADCAST_ORIGIN) return;
		if (!isLocalOrigin(origin, localPeer)) return;
		if (persistence.hasDurableQueue) {
			persistence.offlineQueue.append(update);
		}
		if (persistence.hasCrossTabSync) {
			persistence.broadcastBridge.postUpdate(update);
		}
	};
	if (persistence.enabled) {
		options.doc.on("updateV2", updateHandler);
	}

	// L5 — inbound BroadcastChannel updates. Apply them to the local
	// Y.Doc with a sentinel origin so the outbound handler above
	// short-circuits and we don't echo back. The Y.Doc observer chain
	// then propagates the merged state to other peers and subscribers
	// as if it were any other remote update.
	const unsubscribeRemote = persistence.hasCrossTabSync
		? persistence.broadcastBridge.onRemoteUpdate((update) => {
				try {
					Y.applyUpdateV2(options.doc, update, BROADCAST_ORIGIN);
				} catch {
					// Malformed payload — ignore. The peer that produced
					// it will resync via the primary transport.
				}
			})
		: () => {
				// no-op
			};

	// L5 — hydration. If we have a durable queue with leftover updates
	// from a prior session, replay them into the Y.Doc before the host
	// registers its first `subscribe()`. The `ready` promise resolves
	// to the queued updates; we apply each with a `localPeer` origin
	// so the snapshot module's observer treats them as local saves.
	void persistence.ready.then((queued) => {
		if (queued.length === 0) return;
		options.doc.transact(() => {
			for (const update of queued) {
				try {
					Y.applyUpdateV2(options.doc, update, localPeer);
				} catch {
					// Skip corrupt entries — the queue clears on the next
					// drain regardless.
				}
			}
		}, localPeer);
	});

	// §4.1.1 — opt-in local undo/redo. Wrap a `Y.UndoManager` over the
	// shared type that holds the live PageIR: the native `:tree` map in
	// the default mode, or the legacy whole-document `map` otherwise.
	// Local `save()`s transact with `localPeer` as their origin, so
	// tracking that origin captures the local user's edits while remote
	// peers' changes (a different origin, transport `applyUpdate`) stay
	// off the stack and can never be undone locally. Snapshot
	// metadata/payloads live in `map` (out of the native-tree scope), so
	// undo rewinds live content without rewriting saved history.
	const undoStackListeners = new Set<() => void>();
	let undoManager: Y.UndoManager | undefined;
	let notifyUndoStackChange: (() => void) | undefined;
	if (options.undo) {
		const trackedOrigins = new Set<unknown>([localPeer]);
		if (options.undo.trackedOrigins) {
			for (const origin of options.undo.trackedOrigins) {
				trackedOrigins.add(origin);
			}
		}
		undoManager = new Y.UndoManager(treeRoot ?? map, {
			trackedOrigins,
			...(options.undo.captureTimeout !== undefined
				? { captureTimeout: options.undo.captureTimeout }
				: {}),
		});
		notifyUndoStackChange = () => {
			for (const listener of undoStackListeners) {
				try {
					listener();
				} catch {
					// A faulty host listener must not break the stack
					// observer chain or sibling listeners.
				}
			}
		};
		undoManager.on("stack-item-added", notifyUndoStackChange);
		undoManager.on("stack-item-popped", notifyUndoStackChange);
		undoManager.on("stack-item-updated", notifyUndoStackChange);
		undoManager.on("stack-cleared", notifyUndoStackChange);
	}

	return {
		save(ir: PageIR, meta: Partial<Omit<SnapshotMeta, "id" | "savedAt">>) {
			return snapshots.save(ir, meta);
		},
		list() {
			return snapshots.list();
		},
		load(id: string) {
			return snapshots.load(id);
		},
		delete(id: string) {
			snapshots.delete(id);
		},
		subscribe(onUpdate: (ir: PageIR, peer?: PeerInfo) => void): Unsubscribe {
			const unsubscribe = snapshots.subscribe(onUpdate);
			connectionStatus.notifySubscribeRegistered();
			return unsubscribe;
		},
		onConflict(callback) {
			return conflicts.onConflict(callback);
		},
		onStatusChange(callback) {
			return connectionStatus.onStatusChange(callback);
		},
		getStatus() {
			return connectionStatus.getStatus();
		},
		forceResync() {
			return snapshots.forceResync();
		},
		loadPersistedSnapshot(id: string) {
			return snapshots.loadPersistedSnapshot(id);
		},
		metrics(): MetricsSnapshot {
			return metrics.snapshot();
		},
		recordTiming: metrics.recordTiming,
		incInboundCoalesced: metrics.incInboundCoalesced,
		undo() {
			undoManager?.undo();
		},
		redo() {
			undoManager?.redo();
		},
		canUndo() {
			return undoManager?.canUndo() ?? false;
		},
		canRedo() {
			return undoManager?.canRedo() ?? false;
		},
		clearUndo() {
			undoManager?.clear();
		},
		onUndoStackChange(callback: () => void): Unsubscribe {
			undoStackListeners.add(callback);
			return () => {
				undoStackListeners.delete(callback);
			};
		},
		destroy() {
			map.unobserve(observer);
			if (treeRoot && treeObserver) treeRoot.unobserveDeep(treeObserver);
			awarenessBridge.destroy();
			conflicts.destroy();
			connectionStatus.destroy();
			if (persistence.enabled) {
				options.doc.off("updateV2", updateHandler);
			}
			unsubscribeRemote();
			persistence.destroy();
			if (undoManager) {
				if (notifyUndoStackChange) {
					undoManager.off("stack-item-added", notifyUndoStackChange);
					undoManager.off("stack-item-popped", notifyUndoStackChange);
					undoManager.off("stack-item-updated", notifyUndoStackChange);
					undoManager.off("stack-cleared", notifyUndoStackChange);
				}
				undoManager.destroy();
			}
			undoStackListeners.clear();
		},
		presence: awarenessBridge.presence,
	};
}

/** Sentinel origin tag for Y.Doc updates produced by the BroadcastChannel bridge (L5). */
const BROADCAST_ORIGIN = Symbol.for("@anvilkit/plugin-collab-yjs/broadcast");

function isLocalOrigin(origin: unknown, localPeer: PeerInfo): boolean {
	if (origin === localPeer.id) return true;
	const peer = validatePeerInfo(origin);
	return peer !== null && peer.id === localPeer.id;
}

function createPeerId(): string {
	return `peer-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * §4.2.4 — resolve and validate the shared `Y.Map` name. Rejects a
 * non-string, empty, or whitespace-only `mapName` so the adapter never
 * binds to an unintended (or blank) Y type. `undefined` falls back to
 * {@link DEFAULT_MAP_NAME}.
 */
function resolveMapName(mapName: string | undefined): string {
	if (mapName === undefined) return DEFAULT_MAP_NAME;
	if (typeof mapName !== "string" || mapName.trim().length === 0) {
		throw new InvalidAdapterOptionsError(
			"mapName",
			`createYjsAdapter: \`mapName\` must be a non-empty, non-blank string (received ${JSON.stringify(
				mapName,
			)}). Omit it to use the default "${DEFAULT_MAP_NAME}".`,
		);
	}
	return mapName;
}

/**
 * §4.2.4 — resolve and validate the local peer identity. The configured
 * peer MUST carry a non-empty, non-blank string `id` — it is the Yjs
 * transaction origin used to attribute and filter local writes, so an
 * id-less peer would silently break local/remote discrimination. Omit
 * `peer` to mint an ephemeral id.
 */
function resolveLocalPeer(peer: PeerInfo | undefined): PeerInfo {
	if (peer === undefined) return { id: createPeerId() };
	const id = (peer as { id?: unknown }).id;
	if (typeof id !== "string" || id.trim().length === 0) {
		throw new InvalidAdapterOptionsError(
			"peer.id",
			`createYjsAdapter: \`peer.id\` must be a non-empty, non-blank string identifying the local peer (received ${JSON.stringify(
				id,
			)}). Omit \`peer\` to mint an ephemeral id.`,
		);
	}
	return peer;
}
