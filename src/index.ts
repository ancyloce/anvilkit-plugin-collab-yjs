export { createCollabDataPlugin, createCollabPlugin } from "./plugin.js";
export type {
	AwarenessRateLimitOptions,
	CollabLogger,
	CollabPluginRuntime,
	CollabPolicy,
	ConflictEvent,
	ConflictFieldDetail,
	ConflictResolution,
	ConnectionErrorReason,
	ConnectionSource,
	ConnectionStatus,
	CreateCollabPluginOptions,
	CreateYjsAdapterOptions,
	MetricsSnapshot,
	PersistenceOptions,
	PolicyViolation,
	PropGuardOptions,
	ResolveConflict,
	SnapshotPersistenceAdapter,
	SnapshotPersistenceOptions,
	UndoController,
	UndoOptions,
	ValidateRemoteIR,
	ValidationFailure,
	YjsSnapshotAdapter,
} from "./types/types.js";
export { InvalidAdapterOptionsError } from "./utils/adapter-errors.js";
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
export type {
	PresenceActivity,
	PresenceViewport,
	RichPresenceState,
	RichSnapshotAdapterPresence,
} from "./utils/presence-schema.js";
export {
	MAX_DISPLAY_NAME_LENGTH,
	MAX_NODE_ID_LENGTH,
	MAX_SELECTION_IDS,
	MAX_VIEWPORT_ZOOM,
	MIN_VIEWPORT_ZOOM,
	PRESENCE_SCHEMA_VERSION,
	sanitizeDisplayName,
	sanitizePresenceSelection,
	validatePeerInfo,
	validatePresenceActivity,
	validatePresenceCursor,
	validatePresenceSelection,
	validatePresenceState,
	validatePresenceViewport,
} from "./utils/presence-schema.js";
export {
	usePuckMultiSelection,
	usePuckSelection,
} from "./utils/selection-bridge.js";
export type {
	SharedTypeSupport,
	YSharedTypeName,
} from "./utils/shared-types.js";
export {
	getHostSharedRoot,
	isManagedSharedType,
	SHARED_TYPE_SUPPORT,
} from "./utils/shared-types.js";
export {
	SnapshotCorruptedError,
	SnapshotNotFoundError,
	SnapshotPrunedError,
} from "./utils/snapshot-errors.js";
export { createYjsAdapter } from "./utils/yjs-adapter.js";
