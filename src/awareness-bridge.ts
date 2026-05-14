import type {
	PresenceState,
	SnapshotAdapterPresence,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import type { Awareness } from "y-protocols/awareness";

import type { MetricsState } from "./metrics.js";
import { validatePresenceState } from "./presence-schema.js";
import type { AwarenessRateLimitOptions } from "./types.js";

export interface AwarenessBridge {
	readonly presence: SnapshotAdapterPresence;
	/** Test/telemetry hook — count of `presence.update` calls dropped by the rate-limiter since adapter creation. */
	readonly droppedUpdateCount: () => number;
	destroy(): void;
}

const DEFAULT_PRESENCE_RATE_PER_SECOND = 30;

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
 * - apply a token-bucket rate-limit to outbound `presence.update`
 *   so a misbehaving host (cursor-on-every-mousemove) can't flood
 *   awareness traffic (L3 — default 30/sec, configurable).
 *
 * `destroy()` removes every awareness listener this module registered.
 * The orchestrator (`yjs-adapter.ts`) calls it on the public
 * `destroy()` path so adapter teardowns no longer leak event handlers
 * (C1 — surfaced because anonymous handlers couldn't be removed).
 */
export function createAwarenessBridge(
	awareness: Awareness,
	metrics: MetricsState,
	rateLimit?: AwarenessRateLimitOptions,
): AwarenessBridge {
	const churnHandler = () => {
		metrics.incChurn();
	};
	awareness.on("change", churnHandler);

	const peerChangeHandlers = new Set<() => void>();

	const maxPerSecond =
		rateLimit?.maxPerSecond ?? DEFAULT_PRESENCE_RATE_PER_SECOND;
	const bucketCapacity = Number.isFinite(maxPerSecond)
		? Math.max(1, maxPerSecond)
		: Infinity;
	let tokens = bucketCapacity;
	let lastRefillTs = Date.now();
	let droppedUpdates = 0;

	function takeToken(): boolean {
		if (!Number.isFinite(bucketCapacity)) return true;
		const now = Date.now();
		const elapsed = now - lastRefillTs;
		if (elapsed > 0) {
			tokens = Math.min(
				bucketCapacity,
				tokens + (elapsed * maxPerSecond) / 1000,
			);
			lastRefillTs = now;
		}
		if (tokens >= 1) {
			tokens -= 1;
			return true;
		}
		return false;
	}

	const presence: SnapshotAdapterPresence = {
		update(state: PresenceState): void {
			if (!takeToken()) {
				droppedUpdates += 1;
				return;
			}
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
		droppedUpdateCount: () => droppedUpdates,
		destroy(): void {
			awareness.off("change", churnHandler);
			for (const handler of peerChangeHandlers) {
				awareness.off("change", handler);
			}
			peerChangeHandlers.clear();
		},
	};
}
