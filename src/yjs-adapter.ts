import type { PageIR } from "@anvilkit/core/types";
import type {
	PeerInfo,
	PresenceState,
	SnapshotAdapter,
	SnapshotAdapterPresence,
	SnapshotMeta,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { decodeIR, encodeIR, hashIR } from "./encode.js";
import type { CreateYjsAdapterOptions } from "./types.js";

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
): SnapshotAdapter {
	const map = options.doc.getMap<string>(options.mapName ?? DEFAULT_MAP_NAME);
	const awareness = options.awareness ?? new Awareness(options.doc);
	const localPeer: PeerInfo = options.peer ?? {
		id: createPeerId(),
	};

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
					if (isPresenceState(value)) {
						peers.push(value);
					}
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
				map.set(PAGE_IR_KEY, encoded);
				map.set(LAST_PEER_KEY, JSON.stringify(localPeer));
			}, localPeer);
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
			const observer = (
				event: Y.YMapEvent<string>,
				transaction: Y.Transaction,
			) => {
				if (!event.changes.keys.has(PAGE_IR_KEY)) return;
				if (isLocalOrigin(transaction.origin, localPeer)) return;
				const raw = map.get(PAGE_IR_KEY);
				if (typeof raw !== "string") return;
				const peer = event.changes.keys.has(LAST_PEER_KEY)
					? readLastPeer(map)
					: undefined;
				onUpdate(decodeIR(raw), peer);
			};
			map.observe(observer);
			return () => map.unobserve(observer);
		},
		presence,
	};
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
		return isPeerInfo(parsed) ? parsed : undefined;
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

function isPresenceState(value: unknown): value is PresenceState {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as { peer?: unknown };
	if (!candidate.peer || typeof candidate.peer !== "object") return false;
	const peer = candidate.peer as { id?: unknown };
	return typeof peer.id === "string";
}

function isPeerInfo(value: unknown): value is PeerInfo {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { id?: unknown }).id === "string"
	);
}

function isLocalOrigin(origin: unknown, localPeer: PeerInfo): boolean {
	if (origin === localPeer.id) return true;
	return isPeerInfo(origin) && origin.id === localPeer.id;
}

function createPeerId(): string {
	return `peer-${Math.random().toString(36).slice(2, 10)}`;
}

function createSnapshotId(): string {
	const counter = snapshotCounter;
	snapshotCounter += 1;
	return `snap-${Date.now().toString(36)}-${String(counter).padStart(6, "0")}-${Math.random().toString(36).slice(2, 8)}`;
}
