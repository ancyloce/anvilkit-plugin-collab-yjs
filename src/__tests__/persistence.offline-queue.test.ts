/**
 * @file L5 — OfflineQueue tests against the NullBackend. Verifies the
 * sync/async boundary (append fire-and-forget; drain/hydrate awaited)
 * and that NullBackend is the correct degraded state.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createOfflineQueue } from "../persistence/offline-queue.js";
import { createNullBackend } from "../persistence/storage-backend.js";

function makeUpdate(i: number): Uint8Array {
	const doc = new Y.Doc();
	doc.getMap("m").set("k", i);
	return Y.encodeStateAsUpdateV2(doc);
}

describe("OfflineQueue + NullBackend (L5)", () => {
	it("size() returns 0 for a fresh queue", () => {
		const queue = createOfflineQueue({ getBackend: () => createNullBackend() });
		expect(queue.size()).toBe(0);
	});

	it("append() is fire-and-forget (no throw, no return)", () => {
		const queue = createOfflineQueue({ getBackend: () => createNullBackend() });
		expect(() => queue.append(new Uint8Array([1, 2, 3]))).not.toThrow();
	});

	it("drain() resolves to an empty array on a null backend", async () => {
		const queue = createOfflineQueue({ getBackend: () => createNullBackend() });
		queue.append(new Uint8Array([1, 2, 3]));
		const drained = await queue.drain();
		expect(drained).toEqual([]);
	});

	it("hydrate() resolves to an empty array on a null backend", async () => {
		const queue = createOfflineQueue({ getBackend: () => createNullBackend() });
		const hydrated = await queue.hydrate();
		expect(hydrated).toEqual([]);
	});

	it("destroy() is a no-op on null backend (no throw)", () => {
		const queue = createOfflineQueue({ getBackend: () => createNullBackend() });
		expect(() => queue.destroy()).not.toThrow();
	});

	it("bounds the pre-ready buffer by merging on overflow (Y1)", () => {
		// A `ready` promise that never resolves keeps every append in the
		// in-memory buffer; without the cap it would grow unbounded.
		const queue = createOfflineQueue({
			getBackend: () => createNullBackend(),
			ready: new Promise<void>(() => undefined),
			maxPendingAppends: 4,
		});
		for (let i = 0; i < 50; i += 1) queue.append(makeUpdate(i));
		// Each time the backlog crosses the cap it collapses to one merged
		// update, so size stays bounded instead of reaching 50.
		expect(queue.size()).toBeLessThanOrEqual(5);
	});
});
