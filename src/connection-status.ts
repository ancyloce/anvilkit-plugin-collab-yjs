import type { Unsubscribe } from "@anvilkit/plugin-version-history";

import type { ConnectionSource, ConnectionStatus } from "./types.js";

export interface ConnectionStatusModule {
	getStatus(): ConnectionStatus;
	onStatusChange(callback: (status: ConnectionStatus) => void): Unsubscribe;
	emit(next: ConnectionStatus): void;
	notifySubscribeRegistered(): void;
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
 */
export function createConnectionStatus(
	options: ConnectionStatusOptions,
): ConnectionStatusModule {
	const statusListeners = new Set<(status: ConnectionStatus) => void>();
	let currentStatus: ConnectionStatus = { kind: "connecting" };
	let unsubscribeSource: (() => void) | undefined;

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

	if (options.connectionSource) {
		unsubscribeSource = options.connectionSource(emit);
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
		destroy(): void {
			unsubscribeSource?.();
			unsubscribeSource = undefined;
			statusListeners.clear();
		},
	};
}
