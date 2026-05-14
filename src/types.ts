import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import type {
	PeerInfo,
	SnapshotAdapter,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import type { Config } from "@puckeditor/core";
import type { Awareness } from "y-protocols/awareness";
import type { Doc as YDoc } from "yjs";

export interface CreateYjsAdapterOptions {
	readonly doc: YDoc;
	readonly awareness?: Awareness;
	readonly peer?: PeerInfo;
	readonly mapName?: string;
	/**
	 * Window (ms) during which a remote update touching node IDs the
	 * local peer has recently edited counts as an overlap and fires
	 * `onConflict`. Default: 2000.
	 */
	readonly staleAfterMs?: number;
	/**
	 * Phase 1 opt-in (D1). When `true`, `PageIR` is mirrored as a
	 * flat-addressed `Y.Map` tree so concurrent edits to disjoint
	 * nodes both survive instead of overwriting each other under the
	 * default whole-document LWW. Default: `false`.
	 *
	 * Native-tree replicas and legacy JSON-blob replicas cannot share
	 * a Y.Doc — pick one mode per room.
	 */
	readonly useNativeTree?: boolean;
	/**
	 * Phase 2 (D8). Optional transport-event source. The host calls
	 * the supplied `emit` with normalized `ConnectionStatus` values as
	 * its provider's connection state changes. The adapter exposes
	 * the latest status via `onStatusChange`.
	 *
	 * If omitted, the adapter starts in `connecting` and flips to
	 * `synced` on the first `subscribe` registration so single-process
	 * demos and tests behave sensibly without provider plumbing.
	 */
	readonly connectionSource?: ConnectionSource;
	/**
	 * When `true`, every `save()` computes a structural `IRDiff` against
	 * the previous locally saved IR (or against the empty document for
	 * the first save) and attaches it to the resulting `SnapshotMeta`
	 * as `delta`. Default: `false` (preserves write performance and
	 * snapshot index size). See L2 in the development plan.
	 */
	readonly computeDelta?: boolean;
	/**
	 * Token-bucket rate-limit on outbound `presence.update` calls.
	 * Local cursor/selection updates beyond the bucket are dropped
	 * silently (no churn growth) until tokens replenish. Inbound
	 * awareness changes from other peers are NOT throttled.
	 *
	 * Default: 30 updates per second (`maxPerSecond: 30`).
	 * Set `maxPerSecond` to `Infinity` to disable the limiter.
	 */
	readonly awarenessRateLimit?: AwarenessRateLimitOptions;
	/**
	 * Opt-in cross-tab persistence layer (L5). When omitted, no
	 * IndexedDB or BroadcastChannel calls are made and the adapter
	 * behaves exactly as it did pre-L5. See {@link PersistenceOptions}
	 * for the individual toggles.
	 */
	readonly persistence?: PersistenceOptions;
}

export interface AwarenessRateLimitOptions {
	/**
	 * Maximum sustained outbound `presence.update` calls per second.
	 * The bucket size equals this value so a brief idle period lets a
	 * full-second burst through. Default: 30.
	 */
	readonly maxPerSecond?: number;
}

/**
 * Opt-in cross-tab persistence (L5). The default `createYjsAdapter`
 * call uses no persistence — outbound Y.js updates flow through the
 * host transport (websocket, hocuspocus, etc.) only. Enabling
 * `indexedDb` adds a durable queue so edits made while offline replay
 * on reconnect. Enabling `broadcastChannel` adds same-origin cross-tab
 * sync so two tabs of the same app see each other's edits without
 * round-tripping through the transport.
 *
 * Each backend feature-detects at construction time and degrades
 * silently to a no-op if its API is unavailable (SSR, older browsers,
 * certain test runners).
 */
export interface PersistenceOptions {
	/**
	 * Enable the IndexedDB-backed offline queue. Default: `false`.
	 */
	readonly indexedDb?: boolean;
	/**
	 * Enable same-origin cross-tab sync via `BroadcastChannel`.
	 * Default: `false`.
	 */
	readonly broadcastChannel?: boolean;
	/**
	 * IndexedDB database name. The adapter combines this with the
	 * `mapName` so multiple rooms in the same origin do not collide.
	 * Default: `"anvilkit-collab-yjs"`.
	 */
	readonly dbName?: string;
	/**
	 * BroadcastChannel name. Defaults to `"<dbName>:<mapName>"` so
	 * multiple rooms in the same origin do not collide.
	 */
	readonly channelName?: string;
	/**
	 * IndexedDB schema version. Bumped only when the queue's stored
	 * shape changes; rolling forward never downgrades the on-disk
	 * data. Default: `1`.
	 */
	readonly schemaVersion?: number;
	/**
	 * Notified once when either backend fails to open / falls back to
	 * a no-op. Useful for telemetry — the adapter never throws out of
	 * persistence into the Y.Doc observer chain, so this is the only
	 * way to learn about quota or schema faults.
	 */
	readonly onFault?: (reason: string) => void;
}

/**
 * Discriminated union describing the host transport's lifecycle as
 * observed by the adapter. The five variants give hosts a transport-
 * agnostic surface to render a unified sync indicator without reading
 * provider-specific fields like `wsconnected`.
 */
export type ConnectionStatus =
	| { readonly kind: "connecting" }
	| { readonly kind: "synced"; readonly since: string }
	| {
			readonly kind: "offline";
			readonly since: string;
			/**
			 * Number of local save() calls observed by the adapter since
			 * the last "synced" status. Populated by `createYjsAdapter`
			 * whenever the host's `connectionSource` emits an `offline`
			 * status — the adapter substitutes its internal counter for
			 * whatever value the host passed. Resets to 0 on the next
			 * "synced" transition.
			 */
			readonly queuedEdits: number;
	  }
	| {
			readonly kind: "reconnecting";
			readonly attempt: number;
			readonly backoffMs: number;
	  }
	| {
			readonly kind: "error";
			readonly message: string;
			readonly recoverable: boolean;
	  };

/**
 * Callback wired by the adapter into the host transport. The host
 * invokes `emit` with the latest `ConnectionStatus` when its provider
 * changes state (connect, sync, disconnect, retry, fail).
 *
 * Returns an unsubscribe used by the adapter on `destroy`.
 */
export type ConnectionSource = (
	emit: (status: ConnectionStatus) => void,
) => () => void;

/**
 * Event payload emitted by `YjsSnapshotAdapter.onConflict` when a
 * remote update lands on top of a local in-flight edit.
 */
export interface ConflictEvent {
	readonly kind: "overlap";
	readonly localPeer: PeerInfo;
	readonly remotePeer?: PeerInfo;
	/** Node IDs touched by both sides within `staleAfterMs`. */
	readonly nodeIds: readonly string[];
	/** ISO-8601 timestamp the conflict was detected. */
	readonly at: string;
}

/**
 * Phase 3 (D10) observability snapshot. The adapter maintains lightweight
 * counters and a sliding window of sync latencies; `metrics()` returns a
 * point-in-time view that hosts can stream to telemetry sinks (the docs
 * canary, Datadog, OpenTelemetry, etc.).
 *
 * Latency is measured from the moment a local `save` writes the live
 * `pageIR` key to the moment any peer's observer fires for that update.
 * Samples are recorded against the most-recent local save; remote-only
 * traffic (no local save in the staleness window) is excluded. The
 * window holds the last 200 samples — older samples are evicted FIFO.
 */
export interface MetricsSnapshot {
	/** Number of `save` calls invoked on the adapter since creation. */
	readonly saveCount: number;
	/**
	 * Number of save calls observed at the underlying transport layer
	 * (i.e. that produced a Yjs update). When the adapter is wrapped
	 * with `createDebouncedAdapter`, this stays equal to `saveCount`
	 * because every flushed `save()` reaches the underlying adapter
	 * once. The `saveCoalescingRatio` field is populated by the
	 * debouncer wrapper when wrapped; for the raw adapter it is `1`.
	 */
	readonly transportWrites: number;
	/**
	 * `transportWrites / saveCount`. `1` means no coalescing; `0.5`
	 * means half of all `save()` calls were dropped by an upstream
	 * debouncer wrapper. Held at `1` for the raw adapter.
	 */
	readonly saveCoalescingRatio: number;
	/** Number of remote subscribe-callback invocations that threw. */
	readonly dispatchFailures: number;
	/**
	 * Number of awareness change events observed since adapter
	 * creation. A coarse proxy for presence churn — high values during
	 * idle periods point to a presence-spamming peer or a host that
	 * isn't throttling cursor updates.
	 */
	readonly awarenessChurn: number;
	/** p50 (median) sync latency in milliseconds, or `null` if no samples. */
	readonly syncLatencyP50Ms: number | null;
	/** p95 sync latency in milliseconds, or `null` if no samples. */
	readonly syncLatencyP95Ms: number | null;
	/** Number of latency samples retained in the window. */
	readonly syncLatencySamples: number;
	/** Set when the adapter fell back to legacy `pageIR` after native-tree decode failed. */
	readonly degraded: boolean;
	/**
	 * Number of awareness payloads that failed `validatePresenceState`
	 * since adapter creation. A non-zero value indicates a misbehaving
	 * peer (e.g. an `xss:` color, an oversized displayName, or an
	 * upstream schema drift); hosts can surface this in telemetry to
	 * catch the regression early instead of silently dropping bad peers.
	 */
	readonly presenceValidationFailures: number;
}

/**
 * Yjs-specific extension of `SnapshotAdapter` that exposes the
 * conflict-diagnostics event surface, the connection-state contract,
 * and the force-resync action. `createYjsAdapter` returns this narrow
 * type so hosts can subscribe to overlap events and render sync UI
 * without dropping into Yjs internals.
 */
export interface YjsSnapshotAdapter extends SnapshotAdapter {
	readonly onConflict: (
		callback: (event: ConflictEvent) => void,
	) => Unsubscribe;
	/**
	 * Subscribe to `ConnectionStatus` transitions. The callback is
	 * invoked synchronously with the current status on registration so
	 * hosts can paint an initial state without waiting for the next
	 * transport event.
	 */
	readonly onStatusChange: (
		callback: (status: ConnectionStatus) => void,
	) => Unsubscribe;
	/**
	 * Read the current `ConnectionStatus` synchronously. Useful for
	 * non-React hosts; React hosts should prefer `onStatusChange`
	 * inside a `useSyncExternalStore` to avoid tearing.
	 */
	readonly getStatus: () => ConnectionStatus;
	/**
	 * Discard unsaved local edits and re-emit the latest authoritative
	 * snapshot through `subscribe`. Wired into
	 * `<ForceResyncDialog />` when the host is using the
	 * `@anvilkit/collab-ui` package.
	 *
	 * If no snapshot exists, resolves to `null` and the live IR is
	 * left untouched — hosts should disable the action in that case.
	 */
	readonly forceResync: () => Promise<PageIR | null>;
	/**
	 * Phase 3 (D10) observability snapshot. Cheap to call — it copies
	 * the latency window into a sorted scratch array on each invocation,
	 * which is fine at the host's polling cadence (seconds, not
	 * frames). Hosts stream the snapshot to their telemetry sink.
	 */
	readonly metrics: () => MetricsSnapshot;
	/**
	 * Release internal subscriptions (the optional `connectionSource`
	 * tear-down, status/conflict/subscribe listener sets). Hosts using
	 * `createCollabPlugin` do not need to call this directly — the
	 * Studio plugin's `onDestroy` invokes it automatically.
	 */
	readonly destroy: () => void;
}

/**
 * Hook that runs against a remote `PageIR` before it is dispatched into
 * Puck. Returning `null` or throwing rejects the update; returning a
 * (possibly transformed) `PageIR` allows it to proceed. Defense-in-depth
 * against hostile or buggy peers — every transport is treated as untrusted.
 */
export type ValidateRemoteIR = (ir: PageIR) => PageIR | null;

/**
 * Phase 3 (D6) RBAC + lock policy bridge.
 *
 * `canEdit(node, peer)` is consulted symmetrically:
 *
 * - **Outbound** — before `adapter.save`, every node touched by the
 *   local diff is checked against `policy.canEdit(node, localPeer)`.
 *   If any check returns `false` (or throws), the save is rejected
 *   and `onPolicyViolation` fires with `direction: "outbound"`.
 * - **Inbound** — after `validateRemoteIR`, every node in the
 *   incoming IR is checked against
 *   `policy.canEdit(node, remotePeer ?? localPeer)`. Any rejection
 *   drops the dispatch and fires `onPolicyViolation` with
 *   `direction: "inbound"`.
 *
 * Synchronous throws from `canEdit` are treated as denial. The hook
 * runs against the *whole* IR rather than a structured diff for
 * simplicity at this phase; richer per-node diffs can come in Phase 4.
 */
export interface CollabPolicy {
	readonly canEdit: (node: PageIRNode, peer: PeerInfo) => boolean;
}

/**
 * Reasons a save or dispatch was rejected by `policy.canEdit`.
 */
export interface PolicyViolation {
	readonly direction: "inbound" | "outbound";
	readonly nodeIds: readonly string[];
	readonly peer: PeerInfo;
	readonly error?: unknown;
}

/**
 * Reasons a remote update was rejected after `validateRemoteIR` ran.
 */
export interface ValidationFailure {
	readonly kind: "rejected" | "threw";
	readonly error?: unknown;
}

export interface CreateCollabPluginOptions {
	readonly adapter: SnapshotAdapter;
	readonly puckConfig?: Config;
	/**
	 * Optional hook applied to every remote `PageIR` before dispatch into
	 * Puck. Returning `null` rejects the update and emits a warning via
	 * the Studio plugin context. Synchronous throws are also treated as
	 * a rejection.
	 */
	readonly validateRemoteIR?: ValidateRemoteIR;
	/**
	 * Optional callback invoked when a remote IR is rejected. Useful for
	 * surfacing toasts in host UI. Fires after the warning is logged.
	 */
	readonly onValidationFailure?: (failure: ValidationFailure) => void;
	/**
	 * Phase 3 (D6) policy bridge. Applied symmetrically inbound and
	 * outbound — see {@link CollabPolicy} for semantics.
	 */
	readonly policy?: CollabPolicy;
	/**
	 * Local peer identity used when checking outbound saves and as a
	 * fallback for inbound checks when the remote peer is unknown. If
	 * omitted, `policy.canEdit` is invoked with `{ id: "local" }`.
	 */
	readonly localPeer?: PeerInfo;
	/**
	 * Optional callback fired whenever `policy.canEdit` rejects an
	 * outbound save or an inbound dispatch.
	 */
	readonly onPolicyViolation?: (violation: PolicyViolation) => void;
	/**
	 * Optional callback fired when an outbound `adapter.save(...)` rejects
	 * or throws. Without this hook, transport failures surface as
	 * `unhandledRejection` warnings with no host visibility — wire it to
	 * a toast, telemetry sink, or retry queue.
	 */
	readonly onSaveError?: (error: unknown) => void;
}

export interface CollabPluginRuntime {
	readonly currentIR: () => PageIR | undefined;
}
