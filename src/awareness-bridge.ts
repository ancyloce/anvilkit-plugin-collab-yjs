import type {
	PresenceState,
	SnapshotAdapterPresence,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import type { Awareness } from "y-protocols/awareness";

import type { MetricsState } from "./metrics.js";
import { validatePresenceState } from "./presence-schema.js";

export interface AwarenessBridge {
	readonly presence: SnapshotAdapterPresence;
	destroy(): void;
}

/**
 * Bridge between the host's `Awareness` instance and the
 * `SnapshotAdapterPresence` contract. Owns the local awareness
 * listeners that:
 *
 * - count churn (one increment per `change` event — fed into the
 *   metrics module's sliding window).
 * - filter peer states through `validatePresenceState` so a malformed
 *   payload from one peer never poisons the local view; rejected
 *   payloads bump `presenceValidationFailures` (L7).
 *
 * `destroy()` removes every awareness listener this module registered.
 * The orchestrator (`yjs-adapter.ts`) calls it on the public
 * `destroy()` path so adapter teardowns no longer leak event handlers
 * (C1 — surfaced because anonymous handlers couldn't be removed).
 */
export function createAwarenessBridge(
	awareness: Awareness,
	metrics: MetricsState,
): AwarenessBridge {
	const churnHandler = () => {
		metrics.incChurn();
	};
	awareness.on("change", churnHandler);

	const peerChangeHandlers = new Set<() => void>();

	const presence: SnapshotAdapterPresence = {
		update(state: PresenceState): void {
			// Intentionally outside doc.transact — awareness is a
			// side-channel for ephemeral peer state (cursor, selection,
			// display name) and must NOT be atomic with save() writes.
			// Atomicity would couple presence churn to debouncing and
			// stall remote previews behind unflushed local edits.
			awareness.setLocalState(state as unknown as Record<string, unknown>);
		},
		onPeerChange(
			callback: (peers: readonly PresenceState[]) => void,
		): Unsubscribe {
			const handler = () => {
				const peers: PresenceState[] = [];
				for (const value of awareness.getStates().values()) {
					const validated = validatePresenceState(value);
					if (validated !== null) peers.push(validated);
					else if (value !== undefined && value !== null) {
						metrics.incPresenceValidationFailure();
					}
				}
				callback(peers);
			};
			awareness.on("change", handler);
			peerChangeHandlers.add(handler);
			handler();
			return () => {
				awareness.off("change", handler);
				peerChangeHandlers.delete(handler);
			};
		},
	};

	return {
		presence,
		destroy(): void {
			awareness.off("change", churnHandler);
			for (const handler of peerChangeHandlers) {
				awareness.off("change", handler);
			}
			peerChangeHandlers.clear();
		},
	};
}
