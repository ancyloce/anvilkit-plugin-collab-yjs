import type { PageIR } from "@anvilkit/core/types";
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
}

export interface CollabPluginRuntime {
	readonly currentIR: () => PageIR | undefined;
}
