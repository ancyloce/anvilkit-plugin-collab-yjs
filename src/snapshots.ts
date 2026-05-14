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
	LAST_PEER_KEY,
	LEGACY_SNAPSHOT_INDEX_KEY,
	PAGE_IR_KEY,
	SNAPSHOT_META_PREFIX,
	snapshotMetaKey,
	snapshotPayloadKey,
} from "./keys.js";
import type { MetricsState } from "./metrics.js";
import {
	applyIRToNativeTree,
	NATIVE_VERSION_KEY,
	readNativeTree,
} from "./native-tree.js";
import { validatePeerInfo } from "./presence-schema.js";
import type { ConnectionStatus } from "./types.js";

export interface SnapshotsModuleOptions {
	readonly doc: Y.Doc;
	readonly map: Y.Map<string>;
	readonly treeRoot: Y.Map<unknown> | undefined;
	readonly localPeer: PeerInfo;
	readonly metrics: MetricsState;
	readonly conflicts: ConflictModule;
	readonly getCurrentStatus: () => ConnectionStatus;
	readonly computeDelta: boolean;
}

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
	emitToSubscribers(ir: PageIR, peer?: PeerInfo): void;
	subscribe(onUpdate: (ir: PageIR, peer?: PeerInfo) => void): () => void;
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
		getCurrentStatus,
		computeDelta,
	} = options;
	const subscribeListeners = new Set<(ir: PageIR, peer?: PeerInfo) => void>();
	let lastLocalSavedAt: number | undefined;
	let queuedEdits = 0;

	function readCurrentIR(): PageIR | undefined {
		if (treeRoot) {
			const fromTree = readNativeTree(treeRoot);
			if (fromTree) return fromTree;
			// Native tree was opted in but failed to decode despite
			// holding tree data — fall back to the legacy `pageIR` JSON
			// blob and flag the adapter as degraded so hosts can surface
			// the regression. An empty tree (no version key set yet) is
			// the normal pre-hydration state and is NOT flagged.
			if (treeRoot.has(NATIVE_VERSION_KEY)) metrics.setDegraded(true);
		}
		const raw = map.get(PAGE_IR_KEY);
		if (typeof raw !== "string") return undefined;
		try {
			return decodeIR(raw);
		} catch {
			return undefined;
		}
	}

	function emitToSubscribers(ir: PageIR, peer?: PeerInfo): void {
		for (const listener of subscribeListeners) {
			try {
				listener(ir, peer);
			} catch {
				metrics.incDispatchFailure();
			}
		}
	}

	return {
		save(ir, meta): string {
			const encoded = encodeIR(ir);
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
				pageIRHash: meta.pageIRHash ?? hashIR(encoded),
				...(delta !== undefined ? { delta } : {}),
			};
			doc.transact(() => {
				map.set(snapshotPayloadKey(snapshotMeta.id), encoded);
				map.set(snapshotMetaKey(snapshotMeta.id), JSON.stringify(snapshotMeta));
				if (treeRoot) {
					applyIRToNativeTree(treeRoot, ir, conflicts.getLastLocalIR());
				}
				// PAGE_IR_KEY is still maintained for legacy fallback,
				// snapshot hashing, and conflict-event dispatch even when
				// the native tree is the source of truth.
				map.set(PAGE_IR_KEY, encoded);
				map.set(LAST_PEER_KEY, JSON.stringify(localPeer));
			}, localPeer);
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
			try {
				return decodeIR(irRaw);
			} catch (error) {
				throw new Error(
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
					applyIRToNativeTree(treeRoot, restored, conflicts.getLastLocalIR());
				}
				map.set(PAGE_IR_KEY, irRaw);
				map.set(LAST_PEER_KEY, JSON.stringify(localPeer));
			}, localPeer);
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
