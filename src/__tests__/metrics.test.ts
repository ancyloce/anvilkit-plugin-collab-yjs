/**
 * @file Phase 3 (D10) — observability metrics surface.
 *
 * Pins the contract for `YjsSnapshotAdapter.metrics()`: counters for
 * save volume, dispatch failures, awareness churn, and a sliding
 * window of sync-latency samples that produces p50/p95.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import { createDebouncedAdapter } from "../debounced-adapter.js";
import { createYjsAdapter } from "../yjs-adapter.js";

function pair(a: YDoc, b: YDoc): void {
	a.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(b, u, "replicate");
	});
	b.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(a, u, "replicate");
	});
}

function withHero(headline: string): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [{ id: "hero-1", type: "Hero", props: { headline } }],
		},
	};
}

describe("createYjsAdapter metrics()", () => {
	it("starts with zeroed counters and null latency percentiles", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
		});
		const m = adapter.metrics();
		expect(m.saveCount).toBe(0);
		expect(m.transportWrites).toBe(0);
		expect(m.saveCoalescingRatio).toBe(1);
		expect(m.dispatchFailures).toBe(0);
		expect(m.awarenessChurn).toBe(0);
		expect(m.syncLatencyP50Ms).toBeNull();
		expect(m.syncLatencyP95Ms).toBeNull();
		expect(m.syncLatencySamples).toBe(0);
		expect(m.degraded).toBe(false);
	});

	it("increments saveCount on every save", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
		});
		adapter.save(withHero("v1"), {});
		adapter.save(withHero("v2"), {});
		adapter.save(withHero("v3"), {});
		expect(adapter.metrics().saveCount).toBe(3);
	});

	it("records sync latency samples when remote updates arrive after local saves", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			staleAfterMs: 5000,
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			staleAfterMs: 5000,
		});

		// Alice saves; Bob's reply lands in adapterA's observer and is
		// recorded as a latency sample.
		adapterA.save(withHero("alice writes"), {});
		adapterB.save(withHero("bob writes"), {});

		const m = adapterA.metrics();
		expect(m.syncLatencySamples).toBeGreaterThanOrEqual(1);
		expect(m.syncLatencyP50Ms).not.toBeNull();
		expect(m.syncLatencyP50Ms ?? -1).toBeGreaterThanOrEqual(0);
		expect(m.syncLatencyP95Ms).not.toBeNull();
	});

	it("computes p50 and p95 from the latency window", () => {
		// Drive the percentile helper through observable behaviour: with
		// many samples, p95 ≥ p50.
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			staleAfterMs: 5000,
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			staleAfterMs: 5000,
		});

		for (let i = 0; i < 10; i += 1) {
			adapterA.save(withHero(`alice-${i}`), {});
			adapterB.save(withHero(`bob-${i}`), {});
		}

		const m = adapterA.metrics();
		expect(m.syncLatencySamples).toBeGreaterThan(0);
		expect(m.syncLatencyP50Ms).not.toBeNull();
		expect(m.syncLatencyP95Ms).not.toBeNull();
		expect(m.syncLatencyP95Ms ?? 0).toBeGreaterThanOrEqual(
			m.syncLatencyP50Ms ?? 0,
		);
	});

	it("counts dispatchFailures when a subscribe listener throws", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			staleAfterMs: 5000,
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			staleAfterMs: 5000,
		});

		adapterA.subscribe(() => {
			throw new Error("boom");
		});
		adapterB.save(withHero("triggers dispatch"), {});

		expect(adapterA.metrics().dispatchFailures).toBeGreaterThanOrEqual(1);
	});

	it("tracks awarenessChurn when the awareness state changes", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
		});
		const before = adapter.metrics().awarenessChurn;
		adapter.presence?.update({
			peer: { id: "alice" },
			cursor: { x: 1, y: 1 },
		});
		adapter.presence?.update({
			peer: { id: "alice" },
			cursor: { x: 2, y: 2 },
		});
		expect(adapter.metrics().awarenessChurn).toBeGreaterThan(before);
	});

	it("does not flag degraded when native-tree mode hydrates an empty doc", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			useNativeTree: true,
			peer: { id: "alice" },
		});
		// readCurrentIR is invoked by the observer path; with an empty
		// doc the tree has no version key yet, so degraded must stay
		// false.
		expect(adapter.metrics().degraded).toBe(false);
	});
});

describe("createDebouncedAdapter metrics()", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("tracks save coalescing ratio under burst load", async () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
		});
		const debounced = createDebouncedAdapter(adapter, { ms: 100 });

		// 10 rapid saves within the debounce window collapse to 1
		// transport write.
		for (let i = 0; i < 10; i += 1) {
			debounced.save(withHero(`burst-${i}`), {});
			await vi.advanceTimersByTimeAsync(5);
		}
		await vi.advanceTimersByTimeAsync(150);

		const m = debounced.metrics?.();
		expect(m).toBeDefined();
		if (!m) return;
		expect(m.saveCount).toBe(10);
		expect(m.transportWrites).toBe(1);
		expect(m.saveCoalescingRatio).toBeCloseTo(0.1, 5);
	});

	it("forwards upstream metrics fields untouched", async () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
		});
		const debounced = createDebouncedAdapter(adapter, { ms: 50 });

		debounced.save(withHero("v1"), {});
		await vi.advanceTimersByTimeAsync(100);

		const m = debounced.metrics?.();
		expect(m).toBeDefined();
		if (!m) return;
		// Latency window starts empty (no remote round-trips occurred);
		// the debouncer should still pass through the upstream samples.
		expect(m.syncLatencySamples).toBe(adapter.metrics().syncLatencySamples);
		expect(m.degraded).toBe(adapter.metrics().degraded);
	});
});
