/**
 * @file L5 — IndexedDB backend tests. Uses `fake-indexeddb/auto` to
 * polyfill IDB in the Node 22 test environment. Verifies append /
 * drain / hydrate semantics, size tracking, and the fault-tolerant
 * downgrade to NullBackend when IDB is unavailable.
 */

import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

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

	it("R1 — an append racing a drain is never silently lost", async () => {
		const opts = freshOpts();
		const backend = await createIndexedDbBackend(opts);
		await backend.append(new Uint8Array([1]));
		await backend.append(new Uint8Array([2]));

		// Start the drain and, without awaiting it, interleave a new
		// append. With the old two-transaction read-then-clear an append
		// landing between readAll and clear was wiped without being
		// returned. With the single-cursor drain the racing append must
		// survive: it is either drained or left in the store, but never
		// destroyed without being handed back.
		const drainPromise = backend.drain();
		const appendPromise = backend.append(new Uint8Array([3]));
		const [drained] = await Promise.all([drainPromise, appendPromise]);
		const leftover = await backend.drain();

		const all = [...drained, ...leftover]
			.map((u) => Array.from(u)[0])
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(all).toEqual([1, 2, 3]);
		backend.destroy();
	});

	it("R2 — compact() folds the backlog to the merged blob, equivalent to the originals", async () => {
		const backend = await createIndexedDbBackend(freshOpts());

		// Three real Y.js updates from a doc's history.
		const doc = new Y.Doc();
		const arr = doc.getArray<number>("a");
		const updates: Uint8Array[] = [];
		doc.on("updateV2", (u: Uint8Array) => updates.push(u));
		arr.push([1]);
		arr.push([2]);
		arr.push([3]);
		for (const u of updates) await backend.append(u);
		expect(backend.size()).toBe(3);

		await backend.compact((all) => Y.mergeUpdatesV2(all.map((u) => u)));

		expect(backend.size()).toBe(1);
		const drained = await backend.drain();
		expect(drained).toHaveLength(1);

		// The single retained blob reconstructs the same logical state
		// as replaying the three originals.
		const replay = new Y.Doc();
		Y.applyUpdateV2(replay, drained[0]!);
		expect(replay.getArray<number>("a").toArray()).toEqual([1, 2, 3]);
		backend.destroy();
	});

	it("R2 — compact() is a no-op on <=1 row (no duplication, no loss)", async () => {
		const backend = await createIndexedDbBackend(freshOpts());
		await backend.append(new Uint8Array([9]));
		await backend.compact((all) => all[0]);
		expect(backend.size()).toBe(1);
		const drained = await backend.drain();
		expect(drained).toHaveLength(1);
		expect(Array.from(drained[0]!)).toEqual([9]);
		backend.destroy();
	});

	it("R2 — a row appended during compact survives (append-then-delete-by-key)", async () => {
		const backend = await createIndexedDbBackend(freshOpts());
		await backend.append(new Uint8Array([1]));
		await backend.append(new Uint8Array([2]));

		// The concurrent append gets a higher sequence than the rows
		// compact() snapshotted, so it is outside the deleted key set
		// and is never destroyed.
		const compactPromise = backend.compact((all) =>
			all.length > 1 ? new Uint8Array([0]) : all[0],
		);
		const appendPromise = backend.append(new Uint8Array([3]));
		await Promise.all([compactPromise, appendPromise]);

		const drained = await backend.drain();
		const flat = drained.map((u) => Array.from(u)[0]).sort();
		expect(flat).toContain(3); // racing append preserved
		backend.destroy();
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
