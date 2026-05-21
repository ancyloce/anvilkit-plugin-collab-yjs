/**
 * Constants and key derivers for the shared `Y.Map` slots that back
 * `createYjsAdapter`. Centralized here so adding a new well-known key
 * is a one-file change and so the magic strings cannot accidentally
 * drift between the adapter and its modules.
 */

// Default top-level map name. Every other key below is scoped under this map.
export const DEFAULT_MAP_NAME = "anvilkit-collab";
// Legacy whole-document JSON encoding of the latest live PageIR.
export const PAGE_IR_KEY = "pageIR";
// Pre-snapshotMeta era index of saved snapshots — read-only fallback.
export const LEGACY_SNAPSHOT_INDEX_KEY = "snapshotIndex";
// JSON-encoded PeerInfo of the peer that authored the latest live write.
export const LAST_PEER_KEY = "lastPeer";
// `<prefix><id>` namespace for per-snapshot metadata records.
export const SNAPSHOT_META_PREFIX = "snapshotMeta:";
// `<prefix><id>` namespace for per-snapshot encoded payloads.
export const SNAPSHOT_PAYLOAD_PREFIX = "snapshotPayload:";

// Native-tree (D1 opt-in) keys. Live under the `:tree` sibling Y.Map
// so the legacy and native encodings can co-exist without colliding.
// Encoding schema version — must equal "1" for readNativeTree to decode.
export const NATIVE_VERSION_KEY = "version";
// ID of the root PageIRNode.
export const NATIVE_ROOT_ID_KEY = "rootId";
// JSON-encoded PageIR.assets (opaque for alpha).
export const NATIVE_ASSETS_KEY = "assets";
// JSON-encoded PageIR.metadata (opaque for alpha).
export const NATIVE_METADATA_KEY = "metadata";
// `<prefix><id>` namespace for each PageIRNode's per-node Y.Map.
export const NATIVE_NODE_PREFIX = "node:";

export function snapshotMetaKey(id: string): string {
	return `${SNAPSHOT_META_PREFIX}${id}`;
}

export function snapshotPayloadKey(id: string): string {
	return `${SNAPSHOT_PAYLOAD_PREFIX}${id}`;
}

export function nativeNodeKey(id: string): string {
	return `${NATIVE_NODE_PREFIX}${id}`;
}
