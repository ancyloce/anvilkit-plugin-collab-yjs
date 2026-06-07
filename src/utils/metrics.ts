import type {
	DegradedReason,
	MetricsSnapshot,
	TimingKind,
} from "../types/types.js";

// Re-exported for existing importers (plugin.ts) — canonical home is
// types.ts so metrics.ts and types.ts don't form an import cycle.
export type { TimingKind } from "../types/types.js";

/**
 * Process-monotonic sequence woven into snapshot ids immediately after
 * the millisecond timestamp. `SnapshotMeta` ordering is `savedAt`
 * (ISO, millisecond resolution) then `id.localeCompare`; when several
 * saves — including saves from DIFFERENT adapters on the same doc —
 * land in the same millisecond, the wall clock cannot disambiguate
 * them and the previous random id suffix made the "latest" snapshot
 * non-deterministic (a flaky round-trip). A fixed-width, lexicographic
 * monotonic segment makes in-process save order the deterministic
 * tiebreaker. The per-adapter counter + random suffix are retained for
 * cross-process collision resistance (L2).
 */
let globalSnapshotSeq = 0;

const LATENCY_WINDOW_SIZE = 200;
const CHURN_WINDOW_MS = 5 * 60_000;
const INBOUND_COALESCED_WINDOW_MS = 5 * 60_000;
const TIMING_WINDOW_SIZE = 200;

export interface MetricsState {
	recordObservationLatency(savedAt: number): void;
	incSaveCount(): void;
	incDispatchFailure(): void;
	incChurn(): void;
	incPresenceValidationFailure(): void;
	setDegraded(value: boolean, reason?: DegradedReason): void;
	/** Count remote IRs superseded in the inbound buffer before flush (H1). */
	incInboundCoalesced(n?: number): void;
	/** Record a hot-path stage duration in milliseconds (P1). */
	recordTiming(kind: TimingKind, ms: number): void;
	createSnapshotId(): string;
	snapshot(): MetricsSnapshot;
}

/**
 * Self-contained metrics aggregator. Owns:
 *
 * - saveCount, dispatchFailures, presenceValidationFailures (monotonic
 *   counters).
 * - degraded (boolean flag — native-tree decode fallback indicator).
 * - latencyWindow (200-sample FIFO of observed remote-update latencies).
 * - awarenessChurn — 5-minute sliding window of awareness change events
 *   (L1 review: replaced the previous monotonically-growing counter that
 *   became meaningless on long sessions; L3 widened from 60s to 5min so
 *   short idle gaps don't zero the signal).
 * - snapshot counter — local to this closure so concurrent adapters
 *   on the same Y.Doc no longer share a global counter (L2).
 *
 * `snapshot()` returns a point-in-time `MetricsSnapshot`. Cheap — sorts
 * the latency window into a scratch array on each call, which is fine
 * at host telemetry cadence (seconds, not frames).
 */
export function createMetricsState(): MetricsState {
	let saveCount = 0;
	let dispatchFailures = 0;
	let presenceValidationFailures = 0;
	let degraded = false;
	const degradedReasons = new Set<DegradedReason>();
	let snapshotCounter = 0;
	// Y6 — sliding window of recent inbound-coalesce events (mirrors
	// `churnTimestamps`). The old monotonic `inboundCoalesced` total went
	// meaningless on long sessions, the same anti-pattern already retired for
	// awareness churn (L1).
	const inboundCoalescedEvents: { ts: number; n: number }[] = [];
	const latencyWindow: number[] = [];
	const churnTimestamps: number[] = [];
	const timingWindows = new Map<TimingKind, number[]>();

	function recordTiming(kind: TimingKind, ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) return;
		let window = timingWindows.get(kind);
		if (window === undefined) {
			window = [];
			timingWindows.set(kind, window);
		}
		window.push(ms);
		if (window.length > TIMING_WINDOW_SIZE) window.shift();
	}

	function timingP50(kind: TimingKind): number | null {
		const window = timingWindows.get(kind);
		if (window === undefined || window.length === 0) return null;
		return percentile(
			[...window].sort((a, b) => a - b),
			0.5,
		);
	}

	function trimChurnWindow(now: number): void {
		const cutoff = now - CHURN_WINDOW_MS;
		while (churnTimestamps.length > 0 && churnTimestamps[0]! < cutoff) {
			churnTimestamps.shift();
		}
	}

	function trimInboundWindow(now: number): void {
		const cutoff = now - INBOUND_COALESCED_WINDOW_MS;
		while (
			inboundCoalescedEvents.length > 0 &&
			inboundCoalescedEvents[0]!.ts < cutoff
		) {
			inboundCoalescedEvents.shift();
		}
	}

	return {
		recordObservationLatency(savedAt: number): void {
			const elapsed = Date.now() - savedAt;
			if (!Number.isFinite(elapsed) || elapsed < 0) return;
			latencyWindow.push(elapsed);
			if (latencyWindow.length > LATENCY_WINDOW_SIZE) latencyWindow.shift();
		},
		incSaveCount(): void {
			saveCount += 1;
		},
		incDispatchFailure(): void {
			dispatchFailures += 1;
		},
		incChurn(): void {
			const now = Date.now();
			churnTimestamps.push(now);
			trimChurnWindow(now);
		},
		incPresenceValidationFailure(): void {
			presenceValidationFailures += 1;
		},
		setDegraded(value: boolean, reason?: DegradedReason): void {
			degraded = value;
			// Reasons are an append-only audit trail — never cleared on
			// `setDegraded(false)`, so a transient recovery doesn't erase
			// the evidence a host needs to triage why it happened.
			if (value && reason !== undefined) degradedReasons.add(reason);
		},
		incInboundCoalesced(n = 1): void {
			if (!Number.isFinite(n) || n <= 0) return;
			const now = Date.now();
			inboundCoalescedEvents.push({ ts: now, n });
			trimInboundWindow(now);
		},
		recordTiming,
		createSnapshotId(): string {
			const counter = snapshotCounter;
			snapshotCounter += 1;
			const seq = globalSnapshotSeq;
			globalSnapshotSeq += 1;
			// seq before counter so lexicographic id order == in-process
			// save order within a same-millisecond tie.
			return `snap-${Date.now().toString(36)}-${seq.toString(36).padStart(10, "0")}-${String(counter).padStart(6, "0")}-${Math.random().toString(36).slice(2, 8)}`;
		},
		snapshot(): MetricsSnapshot {
			const now = Date.now();
			trimChurnWindow(now);
			trimInboundWindow(now);
			const sorted = [...latencyWindow].sort((a, b) => a - b);
			let inboundCoalesced = 0;
			for (const event of inboundCoalescedEvents) inboundCoalesced += event.n;
			return {
				saveCount,
				transportWrites: saveCount,
				saveCoalescingRatio: 1,
				dispatchFailures,
				awarenessChurn: churnTimestamps.length,
				syncLatencyP50Ms: percentile(sorted, 0.5),
				syncLatencyP95Ms: percentile(sorted, 0.95),
				syncLatencySamples: sorted.length,
				degraded,
				degradedReasons: [...degradedReasons],
				presenceValidationFailures,
				inboundCoalesced,
				inboundQueueDelayP50Ms: timingP50("inboundQueueDelay"),
				conversionTimeP50Ms: timingP50("conversion"),
				dispatchTimeP50Ms: timingP50("dispatch"),
				saveEncodeTimeP50Ms: timingP50("saveEncode"),
				nativeApplyTimeP50Ms: timingP50("nativeApply"),
				nativeReadTimeP50Ms: timingP50("nativeRead"),
			};
		},
	};
}

/**
 * Monotonic high-resolution clock for hot-path timing. Falls back to
 * `Date.now()` where `performance` is unavailable (older Node, some
 * SSR shims) so timing recording never throws.
 */
export function nowMs(): number {
	return typeof performance !== "undefined" &&
		typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

function percentile(sorted: readonly number[], q: number): number | null {
	if (sorted.length === 0) return null;
	if (sorted.length === 1) return sorted[0] ?? null;
	const rank = (sorted.length - 1) * q;
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	const lowerValue = sorted[lower];
	const upperValue = sorted[upper];
	if (lowerValue === undefined || upperValue === undefined) return null;
	if (lower === upper) return lowerValue;
	return lowerValue + (upperValue - lowerValue) * (rank - lower);
}
