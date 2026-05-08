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
}

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
 * conflict-diagnostics event surface. `createYjsAdapter` returns this
 * narrow type so hosts can subscribe to overlap events without
 * dropping into Yjs internals.
 */
export interface YjsSnapshotAdapter extends SnapshotAdapter {
	readonly onConflict: (
		callback: (event: ConflictEvent) => void,
	) => Unsubscribe;
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
