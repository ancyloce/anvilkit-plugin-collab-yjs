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
import { DEFAULT_MAP_NAME, LAST_PEER_KEY, PAGE_IR_KEY } from "./keys.js";
import { createMetricsState } from "./metrics.js";
import { readNativeTree } from "./native-tree.js";
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
	const useNativeTree = options.useNativeTree ?? false;
	const treeRoot = useNativeTree
		? options.doc.getMap<unknown>(`${options.mapName ?? DEFAULT_MAP_NAME}:tree`)
		: undefined;

	const metrics = createMetricsState();
	const conflicts = createConflicts(staleAfterMs, localPeer);
	const connectionStatus = createConnectionStatus({
		connectionSource: options.connectionSource,
		getQueuedEdits: () => snapshots.getQueuedEdits(),
		onSynced: () => {
			snapshots.resetQueuedEdits();
			conflicts.closeWindow();
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
	});
	const awarenessBridge = createAwarenessBridge(awareness, metrics);

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
		},
		presence: awarenessBridge.presence,
	};
}

function isLocalOrigin(origin: unknown, localPeer: PeerInfo): boolean {
	if (origin === localPeer.id) return true;
	const peer = validatePeerInfo(origin);
	return peer !== null && peer.id === localPeer.id;
}

function createPeerId(): string {
	return `peer-${Math.random().toString(36).slice(2, 10)}`;
}
