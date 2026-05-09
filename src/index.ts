export { createDebouncedAdapter } from "./debounced-adapter.js";
export { decodeIR, encodeIR, hashIR } from "./encode.js";
export { createCollabPlugin } from "./plugin.js";
export { usePuckSelection } from "./selection-bridge.js";
export {
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
	CollabPluginRuntime,
	CollabPolicy,
	ConflictEvent,
	ConnectionSource,
	ConnectionStatus,
	CreateCollabPluginOptions,
	CreateYjsAdapterOptions,
	MetricsSnapshot,
	PolicyViolation,
	ValidateRemoteIR,
	ValidationFailure,
	YjsSnapshotAdapter,
} from "./types.js";
export { createYjsAdapter } from "./yjs-adapter.js";
