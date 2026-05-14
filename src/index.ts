export {
	DebouncedAdapterDestroyedError,
	createDebouncedAdapter,
} from "./debounced-adapter.js";
export { diffSnapshots } from "./diff.js";
export { decodeIR, encodeIR, hashIR } from "./encode.js";
export { createCollabDataPlugin, createCollabPlugin } from "./plugin.js";
export { usePuckSelection } from "./selection-bridge.js";
export {
	MAX_DISPLAY_NAME_LENGTH,
	sanitizeDisplayName,
	validatePeerInfo,
	validatePresenceCursor,
	validatePresenceSelection,
	validatePresenceState,
} from "./presence-schema.js";
export type {
	CreateDebouncedAdapterOptions,
	SnapshotAdapterWithMetrics,
} from "./debounced-adapter.js";
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
} from "./types.js";
export { createYjsAdapter } from "./yjs-adapter.js";
