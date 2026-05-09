import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import type {
	PeerInfo,
	PresenceState,
	SnapshotAdapterPresence,
	SnapshotMeta,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { decodeIR, encodeIR, hashIR } from "./encode.js";
import {
	applyIRToNativeTree,
	NATIVE_VERSION_KEY,
	readNativeTree,
} from "./native-tree.js";
import { validatePeerInfo, validatePresenceState } from "./presence-schema.js";
import type {
	ConflictEvent,
	ConnectionStatus,
	CreateYjsAdapterOptions,
	MetricsSnapshot,
	YjsSnapshotAdapter,
} from "./types.js";

const LATENCY_WINDOW_SIZE = 200;

const DEFAULT_MAP_NAME = "anvilkit-collab";
const PAGE_IR_KEY = "pageIR";
const LEGACY_SNAPSHOT_INDEX_KEY = "snapshotIndex";
const LAST_PEER_KEY = "lastPeer";
const SNAPSHOT_META_PREFIX = "snapshotMeta:";
const SNAPSHOT_PAYLOAD_PREFIX = "snapshotPayload:";
let snapshotCounter = 0;

/**
 * Build a SnapshotAdapter v2 backed by a shared Y.Doc.
 *
 * Encoding is intentionally simple for the alpha cycle: the latest
 * live PageIR is JSON-encoded under one Y.Map key, while saved
 * snapshots are stored under per-id metadata and payload keys. Yjs
 * gives last-writer-wins semantics to the live key with deterministic
 * conflict resolution, which is correct (eventually-consistent +
 * convergent) but coarse-grained. See
 * `docs/architecture/realtime-collab.md` for the alpha trade-offs
 * and the GA plan to mirror the IR tree natively.
 */
export function createYjsAdapter(
	options: CreateYjsAdapterOptions,
): YjsSnapshotAdapter {
	const map = options.doc.getMap<string>(options.mapName ?? DEFAULT_MAP_NAME);
	const awareness = options.awareness ?? new Awareness(options.doc);
	const localPeer: PeerInfo = options.peer ?? {
		id: createPeerId(),
	};
	const staleAfterMs = options.staleAfterMs ?? 2000;
	const useNativeTree = options.useNativeTree ?? false;
	const conflictListeners = new Set<(event: ConflictEvent) => void>();
	const subscribeListeners = new Set<(ir: PageIR, peer?: PeerInfo) => void>();
	const statusListeners = new Set<(status: ConnectionStatus) => void>();
	let currentStatus: ConnectionStatus = { kind: "connecting" };
	let unsubscribeConnectionSource: (() => void) | undefined;
	if (options.connectionSource) {
		unsubscribeConnectionSource = options.connectionSource((next) => {
			emitStatus(next);
		});
	}
	let lastLocalSavedAt: number | undefined;
	let lastLocalIR: PageIR | undefined;
	const treeRoot = useNativeTree
		? options.doc.getMap<unknown>(`${options.mapName ?? DEFAULT_MAP_NAME}:tree`)
		: undefined;
	let saveCount = 0;
	let dispatchFailures = 0;
	let awarenessChurn = 0;
	let degraded = false;
	const latencyWindow: number[] = [];

	function recordLatencySample(savedAt: number): void {
		const elapsed = Date.now() - savedAt;
		if (!Number.isFinite(elapsed) || elapsed < 0) return;
		latencyWindow.push(elapsed);
		if (latencyWindow.length > LATENCY_WINDOW_SIZE) latencyWindow.shift();
	}

	awareness.on("change", () => {
		awarenessChurn += 1;
	});

	const observer = (event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
		if (!event.changes.keys.has(PAGE_IR_KEY)) return;
		if (isLocalOrigin(transaction.origin, localPeer)) return;
		if (lastLocalSavedAt !== undefined) {
			recordLatencySample(lastLocalSavedAt);
		}
		const peer = event.changes.keys.has(LAST_PEER_KEY)
			? readLastPeer(map)
			: undefined;
		const remoteIR = readCurrentIR();
		if (!remoteIR) return;
		maybeFireConflict(remoteIR, peer);
		lastLocalIR = remoteIR;
		for (const listener of subscribeListeners) {
			try {
				listener(remoteIR, peer);
			} catch {
				dispatchFailures += 1;
				// listener errors must not prevent other listeners from
				// receiving the same update.
			}
		}
	};
	map.observe(observer);

	if (treeRoot) {
		const treeObserver = (
			_events: Y.YEvent<Y.AbstractType<unknown>>[],
			transaction: Y.Transaction,
		) => {
			if (isLocalOrigin(transaction.origin, localPeer)) return;
			// The legacy `pageIR` key observer above already handles
			// remote dispatch when it lands in the same transaction. The
			// native-tree observer is only here to keep `lastLocalIR`
			// synced with merged tree state when only the tree changed
			// (e.g. a peer running a future tree-only save path).
			const remoteIR = readNativeTree(treeRoot);
			if (remoteIR) lastLocalIR = remoteIR;
		};
		treeRoot.observeDeep(treeObserver);
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
			if (treeRoot.has(NATIVE_VERSION_KEY)) degraded = true;
		}
		const raw = map.get(PAGE_IR_KEY);
		if (typeof raw !== "string") return undefined;
		try {
			return decodeIR(raw);
		} catch {
			return undefined;
		}
	}

	const presence: SnapshotAdapterPresence = {
		update(state: PresenceState): void {
			awareness.setLocalState(state as unknown as Record<string, unknown>);
		},
		onPeerChange(
			callback: (peers: readonly PresenceState[]) => void,
		): Unsubscribe {
			const handler = () => {
				const peers: PresenceState[] = [];
				for (const value of awareness.getStates().values()) {
					const validated = validatePresenceState(value);
					if (validated !== null) peers.push(validated);
				}
				callback(peers);
			};
			awareness.on("change", handler);
			handler();
			return () => awareness.off("change", handler);
		},
	};

	return {
		save(ir, meta) {
			const encoded = encodeIR(ir);
			const snapshotMeta: SnapshotMeta = {
				id: createSnapshotId(),
				label: meta.label,
				savedAt: new Date().toISOString(),
				pageIRHash: meta.pageIRHash ?? hashIR(encoded),
			};
			options.doc.transact(() => {
				map.set(snapshotPayloadKey(snapshotMeta.id), encoded);
				map.set(snapshotMetaKey(snapshotMeta.id), JSON.stringify(snapshotMeta));
				if (treeRoot) {
					applyIRToNativeTree(treeRoot, ir, lastLocalIR);
				}
				// PAGE_IR_KEY is still maintained for legacy fallback,
				// snapshot hashing, and conflict-event dispatch even when
				// the native tree is the source of truth.
				map.set(PAGE_IR_KEY, encoded);
				map.set(LAST_PEER_KEY, JSON.stringify(localPeer));
			}, localPeer);
			lastLocalIR = ir;
			lastLocalSavedAt = Date.now();
			saveCount += 1;
			return snapshotMeta.id;
		},
		list() {
			return readSnapshotMetas(map);
		},
		load(id) {
			const exists = readSnapshotMetas(map).some((meta) => meta.id === id);
			if (!exists) {
				throw new Error(
					`plugin-collab-yjs: no snapshot with id "${id}" in the shared Y.Doc`,
				);
			}
			const irRaw = map.get(snapshotPayloadKey(id));
			if (typeof irRaw !== "string") {
				throw new Error(
					`plugin-collab-yjs: snapshot metadata references id "${id}" but its payload is missing`,
				);
			}
			return decodeIR(irRaw);
		},
		delete(id) {
			options.doc.transact(() => {
				map.delete(snapshotPayloadKey(id));
				map.delete(snapshotMetaKey(id));
			}, localPeer);
		},
		subscribe(onUpdate: (ir: PageIR, peer?: PeerInfo) => void): Unsubscribe {
			subscribeListeners.add(onUpdate);
			if (!options.connectionSource && currentStatus.kind === "connecting") {
				emitStatus({ kind: "synced", since: new Date().toISOString() });
			}
			return () => {
				subscribeListeners.delete(onUpdate);
			};
		},
		onConflict(callback) {
			conflictListeners.add(callback);
			return () => {
				conflictListeners.delete(callback);
			};
		},
		onStatusChange(callback) {
			statusListeners.add(callback);
			try {
				callback(currentStatus);
			} catch {
				// listener errors must not break registration.
			}
			return () => {
				statusListeners.delete(callback);
			};
		},
		getStatus() {
			return currentStatus;
		},
		async forceResync(): Promise<PageIR | null> {
			const metas = readSnapshotMetas(map);
			const latest = metas[metas.length - 1];
			if (!latest) return null;
			const irRaw = map.get(snapshotPayloadKey(latest.id));
			if (typeof irRaw !== "string") return null;
			const restored = decodeIR(irRaw);
			options.doc.transact(() => {
				if (treeRoot) {
					applyIRToNativeTree(treeRoot, restored, lastLocalIR);
				}
				map.set(PAGE_IR_KEY, irRaw);
				map.set(LAST_PEER_KEY, JSON.stringify(localPeer));
			}, localPeer);
			lastLocalIR = restored;
			lastLocalSavedAt = Date.now();
			for (const listener of subscribeListeners) {
				try {
					listener(restored, localPeer);
				} catch {
					// listener errors must not block resync from completing.
				}
			}
			return restored;
		},
		metrics(): MetricsSnapshot {
			const sorted = [...latencyWindow].sort((a, b) => a - b);
			const p50 = percentile(sorted, 0.5);
			const p95 = percentile(sorted, 0.95);
			return {
				saveCount,
				transportWrites: saveCount,
				saveCoalescingRatio: 1,
				dispatchFailures,
				awarenessChurn,
				syncLatencyP50Ms: p50,
				syncLatencyP95Ms: p95,
				syncLatencySamples: sorted.length,
				degraded,
			};
		},
		destroy() {
			unsubscribeConnectionSource?.();
			unsubscribeConnectionSource = undefined;
			statusListeners.clear();
			subscribeListeners.clear();
			conflictListeners.clear();
		},
		presence,
	};

	function emitStatus(next: ConnectionStatus): void {
		currentStatus = next;
		for (const listener of statusListeners) {
			try {
				listener(next);
			} catch {
				// listener errors must not poison sibling listeners.
			}
		}
	}

	function maybeFireConflict(remoteIR: PageIR, remotePeer?: PeerInfo): void {
		if (conflictListeners.size === 0) return;
		if (lastLocalSavedAt === undefined || lastLocalIR === undefined) return;
		const elapsed = Date.now() - lastLocalSavedAt;
		if (elapsed > staleAfterMs) return;
		const overlap = computeOverlap(lastLocalIR, remoteIR);
		if (overlap.length === 0) return;
		const event: ConflictEvent = {
			kind: "overlap",
			localPeer,
			remotePeer,
			nodeIds: overlap,
			at: new Date().toISOString(),
		};
		for (const listener of conflictListeners) {
			try {
				listener(event);
			} catch {
				// listener errors are swallowed; conflict reporting must not
				// poison the subscribe path.
			}
		}
	}
}

function computeOverlap(local: PageIR, remote: PageIR): readonly string[] {
	const localNodes = collectNodes(local.root);
	const remoteNodes = collectNodes(remote.root);
	const overlap: string[] = [];
	for (const [id, localNode] of localNodes) {
		const remoteNode = remoteNodes.get(id);
		if (!remoteNode) continue;
		if (
			!shallowPropsEqual(localNode.props, remoteNode.props) ||
			!sameChildOrder(localNode.children, remoteNode.children)
		) {
			overlap.push(id);
		}
	}
	return overlap;
}

function collectNodes(node: PageIRNode): Map<string, PageIRNode> {
	const out = new Map<string, PageIRNode>();
	const stack: PageIRNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		out.set(current.id, current);
		if (current.children) stack.push(...current.children);
	}
	return out;
}

function shallowPropsEqual(
	left: Record<string, unknown> | undefined,
	right: Record<string, unknown> | undefined,
): boolean {
	if (left === right) return true;
	const a = left ?? {};
	const b = right ?? {};
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	for (const key of ak) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
	}
	return true;
}

function sameChildOrder(
	left: readonly PageIRNode[] | undefined,
	right: readonly PageIRNode[] | undefined,
): boolean {
	const a = left ?? [];
	const b = right ?? [];
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.id !== b[i]?.id) return false;
	}
	return true;
}

function snapshotMetaKey(id: string): string {
	return `${SNAPSHOT_META_PREFIX}${id}`;
}

function snapshotPayloadKey(id: string): string {
	return `${SNAPSHOT_PAYLOAD_PREFIX}${id}`;
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

function readLastPeer(map: Y.Map<string>): PeerInfo | undefined {
	const raw = map.get(LAST_PEER_KEY);
	if (typeof raw !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		return validatePeerInfo(parsed) ?? undefined;
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
	};
	return (
		typeof candidate.id === "string" &&
		(candidate.label === undefined || typeof candidate.label === "string") &&
		typeof candidate.pageIRHash === "string" &&
		typeof candidate.savedAt === "string"
	);
}

function isLocalOrigin(origin: unknown, localPeer: PeerInfo): boolean {
	if (origin === localPeer.id) return true;
	const peer = validatePeerInfo(origin);
	return peer !== null && peer.id === localPeer.id;
}

function createPeerId(): string {
	return `peer-${Math.random().toString(36).slice(2, 10)}`;
}

function createSnapshotId(): string {
	const counter = snapshotCounter;
	snapshotCounter += 1;
	return `snap-${Date.now().toString(36)}-${String(counter).padStart(6, "0")}-${Math.random().toString(36).slice(2, 8)}`;
}

function percentile(sorted: readonly number[], q: number): number | null {
	if (sorted.length === 0) return null;
	if (sorted.length === 1) return sorted[0] ?? null;
	const rank = (sorted.length - 1) * q;
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	const lowerValue = sorted[lower];
	const upperValue = sorted[upper];
	if (lowerValue === undefined || upperValue === undefined) return null;
	if (lower === upper) return lowerValue;
	return lowerValue + (upperValue - lowerValue) * (rank - lower);
}
