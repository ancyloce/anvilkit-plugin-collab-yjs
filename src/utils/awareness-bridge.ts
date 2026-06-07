import type {
	PresenceState,
	SnapshotAdapterPresence,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";
import type { Awareness } from "y-protocols/awareness";
import type { AwarenessRateLimitOptions } from "../types/types.js";
import { type MetricsState, nowMs } from "./metrics.js";
import { validatePresenceState } from "./presence-schema.js";

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
		// Y8 — isolate like the peer-change handler below: a throw here would
		// otherwise bubble out of the awareness `change` emit and poison every
		// sibling listener on the same event.
		try {
			metrics.incChurn();
		} catch {
			// metrics never throws in practice; stay defensive for parity.
		}
	};
	awareness.on("change", churnHandler);

	const peerChangeHandlers = new Set<() => void>();
	// H1 — per-subscription rAF cancelers so `destroy()` can drop any
	// pending coalesced inbound-presence frame, not just the listeners.
	const frameCancelers = new Set<() => void>();

	const maxPerSecond =
		rateLimit?.maxPerSecond ?? DEFAULT_PRESENCE_RATE_PER_SECOND;
	const bucketCapacity = Number.isFinite(maxPerSecond)
		? Math.max(1, maxPerSecond)
		: Infinity;
	let tokens = bucketCapacity;
	// R5 — monotonic clock so a wall-clock step can't make the
	// token-bucket refill negative (never refills) or huge.
	let lastRefillTs = nowMs();
	let droppedUpdates = 0;

	function takeToken(): boolean {
		if (!Number.isFinite(bucketCapacity)) return true;
		const now = nowMs();
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
			// M5 — keep a validated peer cache keyed by client id and
			// update only the clients named in each awareness change
			// delta, instead of re-validating EVERY peer's state on
			// every cursor tick. Large rooms / high cursor churn now
			// cost O(changed) per event rather than O(peers).
			const cache = new Map<number, PresenceState>();
			let seeded = false;
			// H1 — coalesce the fan-out into the consumer (React setState)
			// to at most one emit per animation frame, mirroring the
			// outbound publisher's batching. yjs does NOT cross-peer batch
			// awareness frames, so a 50-cursor room would otherwise drive
			// ~1,500 synchronous callbacks/sec on every client.
			let frame = 0;

			const refreshClient = (clientId: number): void => {
				const value = awareness.getStates().get(clientId);
				if (value === undefined) {
					cache.delete(clientId);
					return;
				}
				const validated = validatePresenceState(value);
				if (validated !== null) {
					cache.set(clientId, validated);
				} else {
					cache.delete(clientId);
					if (value !== null) metrics.incPresenceValidationFailure();
				}
			};

			const seedAll = (): void => {
				// Initial subscribe (no delta) or a defensive full rebuild:
				// validate every current peer once.
				cache.clear();
				for (const clientId of awareness.getStates().keys()) {
					refreshClient(clientId);
				}
				seeded = true;
			};

			const emit = (): void => {
				frame = 0;
				callback([...cache.values()]);
			};
			const schedule = (): void => {
				if (frame !== 0) return;
				frame =
					typeof requestAnimationFrame === "function"
						? requestAnimationFrame(emit)
						: (setTimeout(emit, 16) as unknown as number);
			};
			const cancelFrame = (): void => {
				if (frame === 0) return;
				if (typeof cancelAnimationFrame === "function") {
					cancelAnimationFrame(frame);
				} else {
					clearTimeout(frame);
				}
				frame = 0;
			};

			const handler = (changes?: {
				added: number[];
				updated: number[];
				removed: number[];
			}) => {
				if (!seeded || !changes) {
					seedAll();
				} else {
					for (const clientId of changes.added) refreshClient(clientId);
					for (const clientId of changes.updated) refreshClient(clientId);
					for (const clientId of changes.removed) cache.delete(clientId);
				}
				schedule();
			};
			awareness.on("change", handler);
			peerChangeHandlers.add(handler);
			frameCancelers.add(cancelFrame);
			// First paint must not wait a frame: seed + emit synchronously.
			seedAll();
			callback([...cache.values()]);
			return () => {
				cancelFrame();
				frameCancelers.delete(cancelFrame);
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
			// H1 — drop any pending coalesced inbound-presence frames.
			for (const cancel of frameCancelers) cancel();
			frameCancelers.clear();
			// F9 — retract local presence on teardown. The host owns the
			// Awareness instance and the documented page-swap pattern is a
			// `key` remount against the SAME doc+awareness (same clientID),
			// so without this the stale local cursor lingers in
			// getStates() and remote peers render a frozen ghost cursor the
			// y-protocols timeout never expires.
			try {
				awareness.setLocalState(null);
			} catch {
				// Host already tore down its Awareness instance.
			}
		},
	};
}
