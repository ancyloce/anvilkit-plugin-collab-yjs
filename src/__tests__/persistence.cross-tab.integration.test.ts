/**
 * @file L5 — Cross-tab persistence integration tests. Spins up two
 * adapters on different Y.Docs with the SAME persistence settings
 * (same dbName + channelName) and verifies that:
 *
 *   - BroadcastChannel propagates local edits to the second adapter
 *     without any explicit transport.
 *   - IndexedDB queue persists outbound updates and the size is
 *     reflected in `getStatus()` when offline.
 *   - Hydration on construction replays previously-queued updates.
 */

import "fake-indexeddb/auto";

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import { createYjsAdapter } from "../yjs-adapter.js";

let testCounter = 0;
function freshDbName(): string {
	testCounter += 1;
	return `anvilkit-collab-yjs-test-${testCounter}`;
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

describe("cross-tab persistence integration (L5)", () => {
	it("BroadcastChannel relays local edits between two adapters", async () => {
		const dbName = freshDbName();
		const docA = new YDoc();
		const docB = new YDoc();

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "tab-a" },
			persistence: { broadcastChannel: true, dbName },
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "tab-b" },
			persistence: { broadcastChannel: true, dbName },
		});

		const received: PageIR[] = [];
		adapterB.subscribe((ir) => received.push(ir));

		adapterA.save(withHero("from-tab-a"), {});

		// BroadcastChannel delivery is async — yield a few macrotasks.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(received.length).toBeGreaterThanOrEqual(1);
		const last = received[received.length - 1];
		expect(last?.root.children?.[0]?.props.headline).toBe("from-tab-a");

		adapterA.destroy();
		adapterB.destroy();
	});

	it("IndexedDB persists updates across adapter destroy/reconstruct", async () => {
		const dbName = freshDbName();
		const docA = new YDoc();

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "tab-a" },
			persistence: { indexedDb: true, dbName },
		});

		adapterA.save(withHero("offline-1"), {});
		adapterA.save(withHero("offline-2"), {});

		// Allow async IDB writes to flush (ready promise resolves,
		// pending buffer drains into the backend, IDB transactions
		// commit). 250ms is generous on fake-indexeddb.
		await new Promise((resolve) => setTimeout(resolve, 250));

		adapterA.destroy();

		// A fresh adapter on a NEW Y.Doc with the same dbName hydrates
		// the leftover updates from IDB into its doc. After hydration,
		// the live IR should reflect the most recent save.
		const docB = new YDoc();
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "tab-b" },
			persistence: { indexedDb: true, dbName },
		});

		// Wait for hydration to complete (ready resolves + applyUpdateV2
		// transacts the queued updates onto docB).
		await new Promise((resolve) => setTimeout(resolve, 250));

		const snapshots = adapterB.list();
		// At least one snapshot was hydrated.
		expect(snapshots.length).toBeGreaterThanOrEqual(1);

		adapterB.destroy();
	});

	it("works without persistence options (backward compatibility)", async () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "tab-a" },
		});
		adapter.save(withHero("v1"), {});
		expect(adapter.list()).toHaveLength(1);
		adapter.destroy();
	});

	it("queuedEdits reflects the IDB queue size when offline", async () => {
		const dbName = freshDbName();
		const doc = new YDoc();

		// Wire up a connectionSource we control — emit offline first so
		// the FSM starts in offline state.
		let emitFn:
			| ((s: import("../types.js").ConnectionStatus) => void)
			| undefined;
		const adapter = createYjsAdapter({
			doc,
			peer: { id: "tab-a" },
			persistence: { indexedDb: true, dbName },
			connectionSource: (emit) => {
				emitFn = emit;
				emit({
					kind: "offline",
					since: new Date().toISOString(),
					queuedEdits: 0,
				});
				return () => {
					// no-op: test owns the emit fn directly
				};
			},
		});

		// While offline, saves accumulate in IDB.
		adapter.save(withHero("offline-1"), {});
		adapter.save(withHero("offline-2"), {});

		await new Promise((resolve) => setTimeout(resolve, 250));

		// Force the FSM to re-emit offline so `getQueuedEdits()` is
		// queried and substituted into the event.
		emitFn?.({
			kind: "offline",
			since: new Date().toISOString(),
			queuedEdits: 0,
		});

		const status = adapter.getStatus();
		expect(status.kind).toBe("offline");
		if (status.kind === "offline") {
			// queuedEdits should reflect IDB queue size (at least 1).
			expect(status.queuedEdits).toBeGreaterThanOrEqual(1);
		}

		adapter.destroy();
	});
});
