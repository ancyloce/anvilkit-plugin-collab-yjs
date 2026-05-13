/**
 * Constants and key derivers for the shared `Y.Map` slots that back
 * `createYjsAdapter`. Centralized here so adding a new well-known key
 * is a one-file change and so the magic strings cannot accidentally
 * drift between the adapter and its modules.
 */

export const DEFAULT_MAP_NAME = "anvilkit-collab";
export const PAGE_IR_KEY = "pageIR";
export const LEGACY_SNAPSHOT_INDEX_KEY = "snapshotIndex";
export const LAST_PEER_KEY = "lastPeer";
export const SNAPSHOT_META_PREFIX = "snapshotMeta:";
export const SNAPSHOT_PAYLOAD_PREFIX = "snapshotPayload:";

export function snapshotMetaKey(id: string): string {
	return `${SNAPSHOT_META_PREFIX}${id}`;
}

export function snapshotPayloadKey(id: string): string {
	return `${SNAPSHOT_PAYLOAD_PREFIX}${id}`;
}
