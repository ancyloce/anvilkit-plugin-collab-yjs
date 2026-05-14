import type { PageIR } from "@anvilkit/core/types";
import type {
	PeerInfo,
	SnapshotMeta,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createAwarenessBridge } from "./awareness-bridge.js";
import { createConflicts } from "./conflicts.js";
import { createConnectionStatus } from "./connection-status.js";
import { decodeIR } from "./encode.js";
import { DEFAULT_MAP_NAME, LAST_PEER_KEY, PAGE_IR_KEY } from "./keys.js";
import { createMetricsState } from "./metrics.js";
import {
	applyIRToNativeTree,
	NATIVE_VERSION_KEY,
	readNativeTree,
} from "./native-tree.js";
import { createPersistence } from "./persistence/index.js";
import { validatePeerInfo } from "./presence-schema.js";
import { createSnapshots } from "./snapshots.js";
import type {
	CreateYjsAdapterOptions,
	MetricsSnapshot,
	YjsSnapshotAdapter,
} from "./types.js";

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
	const map = options.doc.getMap<string>(options.mapName ?? DEFAULT_MAP_NAME);
	const awareness = options.awareness ?? new Awareness(options.doc);
	const localPeer: PeerInfo = options.peer ?? { id: createPeerId() };
	const staleAfterMs = options.staleAfterMs ?? 2000;
	// L1 — native-tree is the default encoding. Hosts can opt back into
	// the legacy whole-document JSON-blob mode by setting
	// `useNativeTree: false`. Native-tree gives per-node CRDT merge
	// semantics so disjoint concurrent edits both survive instead of
	// LWW-clobbering each other.
	const useNativeTree = options.useNativeTree ?? true;
	const treeRoot = useNativeTree
		? options.doc.getMap<unknown>(`${options.mapName ?? DEFAULT_MAP_NAME}:tree`)
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
	const conflicts = createConflicts(staleAfterMs, localPeer);
	const persistence = createPersistence({
		options: options.persistence,
		mapName: options.mapName ?? DEFAULT_MAP_NAME,
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
			// Drain any updates that piled up while offline. Best-effort:
			// failures are surfaced via `persistence.options.onFault`.
			if (persistence.hasDurableQueue) {
				void persistence.offlineQueue.drain();
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
		getCurrentStatus: () => connectionStatus.getStatus(),
		computeDelta: options.computeDelta ?? false,
	});
	const awarenessBridge = createAwarenessBridge(
		awareness,
		metrics,
		options.awarenessRateLimit,
	);

	const observer = (event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
		if (!event.changes.keys.has(PAGE_IR_KEY)) return;
		if (isLocalOrigin(transaction.origin, localPeer)) return;
		const savedAt = snapshots.getLastLocalSavedAt();
		if (savedAt !== undefined) metrics.recordObservationLatency(savedAt);
		const peer = event.changes.keys.has(LAST_PEER_KEY)
			? snapshots.readLastPeer()
			: undefined;
		const remoteIR = snapshots.readCurrentIR();
		if (!remoteIR) return;
		conflicts.maybeFire(remoteIR, peer);
		conflicts.closeWindow();
		conflicts.setLastLocalIR(remoteIR);
		snapshots.emitToSubscribers(remoteIR, peer);
	};
	map.observe(observer);

	const treeObserver = treeRoot
		? (
				_events: Y.YEvent<Y.AbstractType<unknown>>[],
				transaction: Y.Transaction,
			) => {
				if (isLocalOrigin(transaction.origin, localPeer)) return;
				// The PAGE_IR_KEY observer above handles remote dispatch
				// when both land in the same transaction. The tree
				// observer keeps `lastLocalIR` synced with merged tree
				// state when only the tree changed (future tree-only
				// save path).
				const remoteIR = readNativeTree(treeRoot);
				if (remoteIR) conflicts.setLastLocalIR(remoteIR);
			}
		: undefined;
	if (treeRoot && treeObserver) treeRoot.observeDeep(treeObserver);

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
		metrics(): MetricsSnapshot {
			return metrics.snapshot();
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
