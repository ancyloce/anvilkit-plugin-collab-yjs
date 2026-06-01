import type { Unsubscribe } from "@anvilkit/plugin-version-history";

import type { ConnectionSource, ConnectionStatus } from "../types/types.js";

export interface ConnectionStatusModule {
	getStatus(): ConnectionStatus;
	onStatusChange(callback: (status: ConnectionStatus) => void): Unsubscribe;
	emit(next: ConnectionStatus): void;
	notifySubscribeRegistered(): void;
	/**
	 * Subscribe to the host `connectionSource`. Split out of the
	 * constructor so the caller controls *when* the source can first emit
	 * — see the note on {@link createConnectionStatus}. Idempotent: a
	 * second call is a no-op. A no-op when no `connectionSource` is wired.
	 */
	start(): void;
	destroy(): void;
}

export interface ConnectionStatusOptions {
	readonly connectionSource?: ConnectionSource;
	/**
	 * Pulls the current queue depth from the snapshot module. Substituted
	 * into outgoing `offline` events so hosts see an accurate CRDT-derived
	 * queue depth instead of whatever the transport thought it had
	 * buffered (M1).
	 */
	readonly getQueuedEdits: () => number;
	/**
	 * Notified after the FSM emits a `synced` status. Used by:
	 * - the snapshot module to reset `queuedEdits` (M1)
	 * - the conflicts module to close the unconfirmed window (M2)
	 */
	readonly onSynced: () => void;
}

/**
 * Connection-status FSM. Owns the current `ConnectionStatus`, the
 * listener fan-out for `onStatusChange`, and the optional host
 * `connectionSource` subscription.
 *
 * When no `connectionSource` is supplied, the FSM flips from
 * `connecting` to `synced` on the first `notifySubscribeRegistered`
 * call so single-process demos and tests behave sensibly without
 * provider plumbing.
 *
 * The `connectionSource` subscription is **not** wired in the
 * constructor — the caller must invoke {@link ConnectionStatusModule.start}
 * once every module its `emit` path reaches (`onSynced`/`getQueuedEdits`
 * in `createYjsAdapter`, which read the snapshot module) has been
 * constructed. A source that emits its current state *synchronously* on
 * attach (the documented "emit on attach" pattern — the demo Hocuspocus
 * transport and the managed transport both do it) would otherwise run
 * `onSynced` against `snapshots` before it exists: a temporal-dead-zone
 * `ReferenceError` at `<Studio>` mount.
 */
export function createConnectionStatus(
	options: ConnectionStatusOptions,
): ConnectionStatusModule {
	const statusListeners = new Set<(status: ConnectionStatus) => void>();
	let currentStatus: ConnectionStatus = { kind: "connecting" };
	let unsubscribeSource: (() => void) | undefined;
	let started = false;

	function emit(next: ConnectionStatus): void {
		let effective: ConnectionStatus = next;
		if (next.kind === "offline") {
			effective = { ...next, queuedEdits: options.getQueuedEdits() };
		} else if (next.kind === "synced") {
			options.onSynced();
		}
		currentStatus = effective;
		for (const listener of statusListeners) {
			try {
				listener(effective);
			} catch {
				// listener errors must not poison sibling listeners.
			}
		}
	}

	return {
		getStatus(): ConnectionStatus {
			return currentStatus;
		},
		onStatusChange(callback): Unsubscribe {
			statusListeners.add(callback);
			try {
				callback(currentStatus);
			} catch {
				// listener errors must not break registration.
			}
			return () => {
				statusListeners.delete(callback);
			};
		},
		emit,
		notifySubscribeRegistered(): void {
			if (!options.connectionSource && currentStatus.kind === "connecting") {
				emit({ kind: "synced", since: new Date().toISOString() });
			}
		},
		start(): void {
			// Deferred until the adapter has built every module `emit` can
			// reach (the snapshot module that `onSynced`/`getQueuedEdits`
			// read). A `connectionSource` that emits synchronously on attach
			// would otherwise TDZ-crash here — see the note on
			// `createConnectionStatus`. Idempotent.
			if (started) {
				return;
			}
			started = true;
			if (options.connectionSource) {
				unsubscribeSource = options.connectionSource(emit);
			}
		},
		destroy(): void {
			unsubscribeSource?.();
			unsubscribeSource = undefined;
			statusListeners.clear();
		},
	};
}
