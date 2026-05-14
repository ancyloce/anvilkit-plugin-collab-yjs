import type { MetricsSnapshot } from "./types.js";

const LATENCY_WINDOW_SIZE = 200;
const CHURN_WINDOW_MS = 5 * 60_000;

export interface MetricsState {
	recordObservationLatency(savedAt: number): void;
	incSaveCount(): void;
	incDispatchFailure(): void;
	incChurn(): void;
	incPresenceValidationFailure(): void;
	setDegraded(value: boolean): void;
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
	let snapshotCounter = 0;
	const latencyWindow: number[] = [];
	const churnTimestamps: number[] = [];

	function trimChurnWindow(now: number): void {
		const cutoff = now - CHURN_WINDOW_MS;
		while (churnTimestamps.length > 0 && churnTimestamps[0]! < cutoff) {
			churnTimestamps.shift();
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
		setDegraded(value: boolean): void {
			degraded = value;
		},
		createSnapshotId(): string {
			const counter = snapshotCounter;
			snapshotCounter += 1;
			return `snap-${Date.now().toString(36)}-${String(counter).padStart(6, "0")}-${Math.random().toString(36).slice(2, 8)}`;
		},
		snapshot(): MetricsSnapshot {
			trimChurnWindow(Date.now());
			const sorted = [...latencyWindow].sort((a, b) => a - b);
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
				presenceValidationFailures,
			};
		},
	};
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
