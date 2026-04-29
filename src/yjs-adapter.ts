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
const SNAPSHOT_INDEX_KEY = "snapshotIndex";

/**
 * Build a SnapshotAdapter v2 backed by a shared Y.Doc.
 *
 * Encoding is intentionally simple for the alpha cycle: the entire
 * PageIR is JSON-encoded and stored under a single Y.Map key. Yjs
 * gives last-writer-wins semantics with deterministic conflict
 * resolution, which is correct (eventually-consistent + convergent)
 * but coarse-grained. See `docs/architecture/realtime-collab.md` for
 * the alpha trade-offs and the GA plan to mirror the IR tree natively.
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
				map.set(PAGE_IR_KEY, encoded);
				map.set(SNAPSHOT_INDEX_KEY, JSON.stringify([snapshotMeta]));
			}, localPeer.id);
			return snapshotMeta.id;
		},
		list() {
			const raw = map.get(SNAPSHOT_INDEX_KEY);
			if (typeof raw !== "string") return [];
			try {
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? (parsed as readonly SnapshotMeta[]) : [];
			} catch {
				return [];
			}
		},
		load(id) {
			const indexRaw = map.get(SNAPSHOT_INDEX_KEY);
			const exists =
				typeof indexRaw === "string" &&
				JSON.parse(indexRaw).some(
					(meta: SnapshotMeta) => meta.id === id,
				);
			if (!exists) {
				throw new Error(
					`plugin-collab-yjs: no snapshot with id "${id}" in the shared Y.Doc`,
				);
			}
			const irRaw = map.get(PAGE_IR_KEY);
			if (typeof irRaw !== "string") {
				throw new Error(
					`plugin-collab-yjs: snapshot index references id "${id}" but pageIR is missing`,
				);
			}
			return decodeIR(irRaw);
		},
		subscribe(onUpdate: (ir: PageIR, peer?: PeerInfo) => void): Unsubscribe {
			const observer = (
				event: Y.YMapEvent<string>,
				transaction: Y.Transaction,
			) => {
				if (!event.changes.keys.has(PAGE_IR_KEY)) return;
				if (transaction.origin === localPeer.id) return;
				const raw = map.get(PAGE_IR_KEY);
				if (typeof raw !== "string") return;
				const peer = isPeerInfo(transaction.origin)
					? transaction.origin
					: undefined;
				onUpdate(decodeIR(raw), peer);
			};
			map.observe(observer);
			return () => map.unobserve(observer);
		},
		presence,
	};
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

function createPeerId(): string {
	return `peer-${Math.random().toString(36).slice(2, 10)}`;
}

function createSnapshotId(): string {
	return `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
