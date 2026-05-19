import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import type {
	PeerInfo,
	SnapshotAdapter,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import type { Config } from "@puckeditor/core";
import type { Awareness } from "y-protocols/awareness";
import type { Doc as YDoc } from "yjs";

import type { InboundSchedulerHandleScheduler } from "./inbound-scheduler.js";

/**
 * Hot-path stage measured for P1 timing telemetry. Each kind keeps its
 * own FIFO window so hosts can see exactly where main-thread time goes
 * under high load (inbound coalescing delay, IR<->Puck conversion,
 * Puck dispatch, save-time encode/hash, native-tree apply/read).
 * Defined here (not in metrics.ts) so metrics.ts ↔ types.ts stay
 * acyclic.
 */
export type TimingKind =
	| "inboundQueueDelay"
	| "conversion"
	| "dispatch"
	| "saveEncode"
	| "nativeApply"
	| "nativeRead";

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
	 * When `true` (the **default**), `PageIR` is mirrored as a
	 * flat-addressed `Y.Map` tree so concurrent edits to disjoint
	 * nodes both survive instead of overwriting each other under
	 * whole-document LWW. Set `false` to opt back into the legacy
	 * whole-document JSON-blob encoding. Default: `true`.
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
	 * I2 — hard ceiling on retained snapshots in the shared `Y.Doc`.
	 *
	 * Every `save()` writes a full-document payload + meta; with no
	 * pruning the CRDT grew unboundedly (OOM, bloated sync — see the
	 * high-load report's 5.6 GB RSS). Once the retained count exceeds
	 * this value the oldest payload+meta pairs are evicted in the SAME
	 * transaction as the write, so the bound is a hard CRDT invariant
	 * rather than a consumer responsibility. The newest snapshot and
	 * the live native tree are always retained, so `forceResync` /
	 * cold-join are unaffected — only ancient history is dropped. A
	 * consuming version-history plugin's own `maxSnapshots` should be
	 * ≤ this ceiling. Set `<= 0` to disable the cap (NOT recommended).
	 * Default: `200`.
	 */
	readonly maxSnapshots?: number;
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
/**
 * A2 — why the adapter degraded. The three native-tree read-guard
 * trips plus the legacy-blob decode fallback. Superset of
 * `ReadGuardTrip` (native-tree.ts) so a guard reason flows through
 * `setDegraded` without a lossy cast.
 */
export type DegradedReason =
	| "cycle"
	| "max-depth"
	| "max-nodes"
	| "decode-failure";

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
	 * A2 — distinct reasons the adapter has ever degraded, for
	 * production incident triage (the bare `degraded` boolean said
	 * *that* it degraded but never *why*). `"cycle"` / `"max-depth"` /
	 * `"max-nodes"` are native-tree read-guard trips; `"decode-failure"`
	 * is an undecodable native tree falling back to the legacy blob.
	 * Empty while healthy; deduplicated; insertion-ordered.
	 */
	readonly degradedReasons: readonly DegradedReason[];
	/**
	 * Number of awareness payloads that failed `validatePresenceState`
	 * since adapter creation. A non-zero value indicates a misbehaving
	 * peer (e.g. an `xss:` color, an oversized displayName, or an
	 * upstream schema drift); hosts can surface this in telemetry to
	 * catch the regression early instead of silently dropping bad peers.
	 */
	readonly presenceValidationFailures: number;
	/**
	 * Number of inbound remote IRs that were superseded in the
	 * latest-wins coalescing buffer before they could be dispatched
	 * (H1). A non-zero value means the adapter is actively protecting
	 * the editor from a high-frequency remote burst — the host saw the
	 * latest state without paying for every intermediate one.
	 */
	readonly inboundCoalesced: number;
	/**
	 * p50 delay in milliseconds between a remote IR being enqueued and
	 * the coalescing scheduler flushing it to Puck, or `null` if no
	 * samples. Rises when the main thread is saturated.
	 */
	readonly inboundQueueDelayP50Ms: number | null;
	/** p50 IR<->Puck conversion time (ms), or `null` if no samples. */
	readonly conversionTimeP50Ms: number | null;
	/** p50 Puck dispatch time (ms) for a remote update, or `null`. */
	readonly dispatchTimeP50Ms: number | null;
	/** p50 save-time IR encode + hash (ms), or `null` if no samples. */
	readonly saveEncodeTimeP50Ms: number | null;
	/** p50 `applyIRToNativeTree` time (ms), or `null` if no samples. */
	readonly nativeApplyTimeP50Ms: number | null;
	/** p50 native-tree read/reconstruct time (ms), or `null`. */
	readonly nativeReadTimeP50Ms: number | null;
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
	 * Internal-but-stable hot-path timing sink (P1). The Studio plugin
	 * records inbound-queue-delay, IR<->Puck conversion, and Puck
	 * dispatch durations here so they surface in `metrics()` alongside
	 * the adapter-side encode/apply/read timings. Feature-detected by
	 * the plugin — a non-Yjs adapter without it simply skips timings.
	 */
	readonly recordTiming?: (kind: TimingKind, ms: number) => void;
	/**
	 * Internal-but-stable counter sink (H1). The Studio plugin reports
	 * the number of inbound remote IRs the coalescing scheduler dropped
	 * here so it surfaces in `metrics().inboundCoalesced`.
	 */
	readonly incInboundCoalesced?: (n: number) => void;
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
/**
 * P1 — a topology change that is NOT a whole-document rebuild: nodes
 * added/removed at the tree root and/or parents whose `childIds` were
 * reordered or had membership change. The live-IR cache uses this to
 * relink only the affected subtrees instead of re-parsing every node
 * (the old binary `structural` flag forced a full `readNativeTree`
 * re-parse — re-`JSON.parse` of every prop of every node — on every
 * connected peer for a routine drag-reorder).
 */
export interface RelinkDelta {
	/** Node ids whose `node:<id>` map was newly added at the root. */
	readonly addedIds: ReadonlySet<string>;
	/** Node ids whose `node:<id>` map was removed at the root. */
	readonly removedIds: ReadonlySet<string>;
	/** Node ids whose `childIds` order/membership changed. */
	readonly parentsTouched: ReadonlySet<string>;
}

/**
 * Set of node ids touched by a single inbound remote update.
 *
 * `structural` now means strictly "a full rebuild is required" —
 * reserved for whole-document changes (root id / version / assets /
 * metadata) and any case the incremental relink cannot prove. A
 * reorder / insert / delete instead reports `structural: false` plus a
 * {@link RelinkDelta} so the live-IR cache relinks only affected
 * subtrees (P1). When `relink` is present the plugin still takes its
 * proven full `irToPuckData` + `setData` dispatch path (a topology
 * change is not a scoped `replace`), so Puck-side output is byte-
 * identical to before — the win is removing the O(document) re-parse
 * fan-out across peers.
 *
 * Computed once by the adapter's `deriveChangedNodeIds` and threaded
 * through `subscribe` → scheduler → `dispatchRemoteIR`. Always
 * optional: when absent (legacy adapters, JSON-blob mode, hydration)
 * the plugin keeps its existing O(document) full-diff path.
 */
export interface RemoteChange {
	readonly ids: ReadonlySet<string>;
	readonly structural: boolean;
	readonly relink?: RelinkDelta;
}

/**
 * Callback shape the adapter invokes for every emitted IR. The optional
 * third argument is the {@link RemoteChange} for inbound remote
 * updates; local re-emits and hydration omit it. Structurally
 * assignable to the upstream `SnapshotAdapter.subscribe` callback
 * (the extra param is optional), so threading it requires no change to
 * `@anvilkit/plugin-version-history`.
 */
export type RemoteAwareSubscriber = (
	ir: PageIR,
	peer?: PeerInfo,
	changed?: RemoteChange,
) => void;

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
	 * omitted, the plugin mints a per-instance ephemeral id
	 * (`local-<uuid>`) and logs a warning — it does NOT fall back to a
	 * shared `{ id: "local" }`, which used to collapse multi-peer
	 * sessions into one fake user. Provide a stable id in production.
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
	/**
	 * H1 — override the inbound coalescing scheduler. Defaults to
	 * `requestAnimationFrame` (browser editor) or `setTimeout`
	 * (SSR/Node). Tests inject a manual scheduler to pump flushes
	 * deterministically; do not set this in production.
	 */
	readonly inboundScheduler?: InboundSchedulerHandleScheduler;
	/**
	 * H1 — fallback flush cadence in milliseconds when no
	 * `requestAnimationFrame` is available. Default 16.
	 */
	readonly inboundBudgetMs?: number;
	/**
	 * P1 — at or below this many per-node `replace` actions the plugin
	 * dispatches them individually (only the touched components
	 * re-render); above it a single `setData` is cheaper than N
	 * dispatches. Default `50` ({@link REPLACE_BATCH_THRESHOLD}). Tune
	 * for hosts with very large bulk-edit bursts without a release.
	 */
	readonly replaceBatchThreshold?: number;
}

export interface CollabPluginRuntime {
	readonly currentIR: () => PageIR | undefined;
}
