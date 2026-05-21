/**
 * @file L3 — token-bucket rate-limit on outbound `presence.update`.
 *
 * Verifies the bucket consumes one token per call, refills at the
 * configured rate, drops excess updates silently (no awareness write),
 * and the `Infinity` override disables the limiter entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { Doc as YDoc } from "yjs";

import { createYjsAdapter } from "../yjs-adapter.js";

describe("awareness rate-limit (L3)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("defaults to 30 updates per second and drops the rest", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const setLocalSpy = vi.spyOn(awareness, "setLocalState");
		const adapter = createYjsAdapter({
			doc,
			awareness,
			peer: { id: "alice" },
		});

		// 100 calls inside the same instant — only the initial bucket
		// (30) reaches awareness.setLocalState; the rest are dropped.
		for (let i = 0; i < 100; i += 1) {
			adapter.presence?.update({
				peer: { id: "alice" },
				cursor: { x: i, y: i },
			});
		}

		expect(setLocalSpy).toHaveBeenCalledTimes(30);
	});

	it("replenishes tokens at the configured rate after a pause", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const setLocalSpy = vi.spyOn(awareness, "setLocalState");
		const adapter = createYjsAdapter({
			doc,
			awareness,
			peer: { id: "alice" },
			awarenessRateLimit: { maxPerSecond: 10 },
		});

		// Drain the bucket with 10 immediate updates.
		for (let i = 0; i < 10; i += 1) {
			adapter.presence?.update({
				peer: { id: "alice" },
				cursor: { x: i, y: 0 },
			});
		}
		expect(setLocalSpy).toHaveBeenCalledTimes(10);

		// Drops while empty.
		adapter.presence?.update({
			peer: { id: "alice" },
			cursor: { x: 99, y: 0 },
		});
		expect(setLocalSpy).toHaveBeenCalledTimes(10);

		// After ~1s the bucket is full again (rate = 10/sec, capacity = 10).
		vi.advanceTimersByTime(1000);
		for (let i = 0; i < 10; i += 1) {
			adapter.presence?.update({
				peer: { id: "alice" },
				cursor: { x: i, y: 1 },
			});
		}
		expect(setLocalSpy).toHaveBeenCalledTimes(20);
	});

	it("respects a custom `maxPerSecond` setting", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const setLocalSpy = vi.spyOn(awareness, "setLocalState");
		const adapter = createYjsAdapter({
			doc,
			awareness,
			peer: { id: "alice" },
			awarenessRateLimit: { maxPerSecond: 5 },
		});

		for (let i = 0; i < 50; i += 1) {
			adapter.presence?.update({
				peer: { id: "alice" },
				cursor: { x: i, y: 0 },
			});
		}
		expect(setLocalSpy).toHaveBeenCalledTimes(5);
	});

	it("disables the limiter when `maxPerSecond` is `Infinity`", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const setLocalSpy = vi.spyOn(awareness, "setLocalState");
		const adapter = createYjsAdapter({
			doc,
			awareness,
			peer: { id: "alice" },
			awarenessRateLimit: { maxPerSecond: Number.POSITIVE_INFINITY },
		});

		for (let i = 0; i < 250; i += 1) {
			adapter.presence?.update({
				peer: { id: "alice" },
				cursor: { x: i, y: 0 },
			});
		}
		expect(setLocalSpy).toHaveBeenCalledTimes(250);
	});

	it("does not bump awarenessChurn for dropped updates", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const adapter = createYjsAdapter({
			doc,
			awareness,
			peer: { id: "alice" },
			awarenessRateLimit: { maxPerSecond: 2 },
		});

		// Need an onPeerChange subscriber for awareness events to fire
		// observable handlers — but churn is incremented unconditionally
		// on the upstream `change` event. The point of this test is that
		// dropped updates never reach `awareness.setLocalState`, so they
		// never produce a `change` event, so churn must reflect at most
		// 2 increments for 100 calls.
		for (let i = 0; i < 100; i += 1) {
			adapter.presence?.update({
				peer: { id: "alice" },
				cursor: { x: i, y: 0 },
			});
		}
		const churn = adapter.metrics().awarenessChurn;
		// Bucket capacity is 2 → at most 2 setLocalState → at most 2
		// awareness change events.
		expect(churn).toBeLessThanOrEqual(2);
	});
});
