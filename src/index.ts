export { createCollabDataPlugin, createCollabPlugin } from "./plugin.js";
export type {
	AwarenessRateLimitOptions,
	CollabPluginRuntime,
	CollabPolicy,
	ConflictEvent,
	ConnectionSource,
	ConnectionStatus,
	CreateCollabPluginOptions,
	CreateYjsAdapterOptions,
	MetricsSnapshot,
	PersistenceOptions,
	PolicyViolation,
	ValidateRemoteIR,
	ValidationFailure,
	YjsSnapshotAdapter,
} from "./types/types.js";
export type {
	CreateDebouncedAdapterOptions,
	SnapshotAdapterWithMetrics,
} from "./utils/debounced-adapter.js";
export {
	createDebouncedAdapter,
	DebouncedAdapterDestroyedError,
} from "./utils/debounced-adapter.js";
export { diffSnapshots } from "./utils/diff.js";
export { decodeIR, encodeIR, hashIR } from "./utils/encode.js";
export {
	MAX_DISPLAY_NAME_LENGTH,
	sanitizeDisplayName,
	validatePeerInfo,
	validatePresenceCursor,
	validatePresenceSelection,
	validatePresenceState,
} from "./utils/presence-schema.js";
export { usePuckSelection } from "./utils/selection-bridge.js";
export {
	SnapshotCorruptedError,
	SnapshotNotFoundError,
	SnapshotPrunedError,
} from "./utils/snapshot-errors.js";
export { createYjsAdapter } from "./utils/yjs-adapter.js";
