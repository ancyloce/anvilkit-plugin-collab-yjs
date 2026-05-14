/**
 * @file L5 — IndexedDB backend tests. Uses `fake-indexeddb/auto` to
 * polyfill IDB in the Node 22 test environment. Verifies append /
 * drain / hydrate semantics, size tracking, and the fault-tolerant
 * downgrade to NullBackend when IDB is unavailable.
 */

import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";

import { createIndexedDbBackend } from "../persistence/indexed-db.js";

const TEST_OPTS = {
	dbName: "anvilkit-test",
	schemaVersion: 1,
	mapName: "test-map",
} as const;

let dbCounter = 0;
function freshOpts() {
	dbCounter += 1;
	return { ...TEST_OPTS, mapName: `test-map-${dbCounter}` };
}

describe("IndexedDbBackend (L5)", () => {
	it("starts empty (size 0, drain empty)", async () => {
		const backend = await createIndexedDbBackend(freshOpts());
		expect(backend.size()).toBe(0);
		expect(await backend.drain()).toEqual([]);
		backend.destroy();
	});

	it("persists appended updates and drains them in order", async () => {
		const opts = freshOpts();
		const backend = await createIndexedDbBackend(opts);

		await backend.append(new Uint8Array([1, 2, 3]));
		await backend.append(new Uint8Array([4, 5, 6]));
		await backend.append(new Uint8Array([7, 8, 9]));

		expect(backend.size()).toBe(3);

		const drained = await backend.drain();
		expect(drained).toHaveLength(3);
		expect(Array.from(drained[0]!)).toEqual([1, 2, 3]);
		expect(Array.from(drained[1]!)).toEqual([4, 5, 6]);
		expect(Array.from(drained[2]!)).toEqual([7, 8, 9]);

		// Drain clears the store.
		expect(backend.size()).toBe(0);
		backend.destroy();
	});

	it("hydrate() reads without clearing", async () => {
		const opts = freshOpts();
		const backend = await createIndexedDbBackend(opts);
		await backend.append(new Uint8Array([1, 2, 3]));
		const hydrated = await backend.hydrate();
		expect(hydrated).toHaveLength(1);
		expect(backend.size()).toBe(1); // hydrate must NOT clear
		backend.destroy();
	});

	it("a second backend opened on the same db sees previously appended data", async () => {
		const opts = freshOpts();
		const a = await createIndexedDbBackend(opts);
		await a.append(new Uint8Array([10, 11, 12]));
		a.destroy();

		const b = await createIndexedDbBackend(opts);
		const hydrated = await b.hydrate();
		expect(hydrated).toHaveLength(1);
		expect(Array.from(hydrated[0]!)).toEqual([10, 11, 12]);
		b.destroy();
	});

	it("downgrades to a no-op backend when indexedDB is unavailable", async () => {
		const original = (globalThis as { indexedDB?: unknown }).indexedDB;
		(globalThis as { indexedDB?: unknown }).indexedDB = undefined;
		const onFault = vi.fn();
		try {
			const backend = await createIndexedDbBackend({
				...freshOpts(),
				onFault,
			});
			expect(onFault).toHaveBeenCalledWith("indexed-db-unavailable");
			// Operations on the null backend are silent no-ops.
			await backend.append(new Uint8Array([1]));
			expect(backend.size()).toBe(0);
			expect(await backend.drain()).toEqual([]);
			backend.destroy();
		} finally {
			(globalThis as { indexedDB?: unknown }).indexedDB = original;
		}
	});
});
