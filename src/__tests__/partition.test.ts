/**
 * @file M12 / phase6-018 — partition + reconnect integration test.
 *
 * Models a network partition with a controllable in-process
 * "transport". Two YDocs share updates only while the link is open;
 * `disconnect()` queues each side's outbound updates without
 * delivering them, and `connect()` flushes the queue both ways. The
 * test asserts:
 *
 *   1. Edits made on each side while disconnected merge cleanly on
 *      reconnect — no LWW data loss for additive operations.
 *   2. The plugin's `subscribe()` callback fires for every remote
 *      update once the link is restored.
 *   3. No spurious local-origin callbacks are issued for edits a
 *      replica made itself (the local-origin filter still holds
 *      across the partition seam).
 *
 * The partition harness lives only in this file — Yjs has no built-in
 * partitionable transport, and `y-websocket` is overkill for an
 * in-process test.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import type { ConflictEvent } from "../types.js";
import { createYjsAdapter } from "../yjs-adapter.js";

/**
 * In-process partitionable link. Calling `disconnect()` parks every
 * subsequent update on each side; `connect()` flushes both queues
 * and resumes live forwarding.
 */
function makePartitionableLink(a: YDoc, b: YDoc) {
	let connected = true;
	const queueAtoB: Uint8Array[] = [];
	const queueBtoA: Uint8Array[] = [];

	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === "replicate") return;
		if (connected) applyUpdate(b, update, "replicate");
		else queueAtoB.push(update);
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === "replicate") return;
		if (connected) applyUpdate(a, update, "replicate");
		else queueBtoA.push(update);
	});

	return {
		disconnect() {
			connected = false;
		},
		connect() {
			connected = true;
			while (queueAtoB.length > 0) {
				const next = queueAtoB.shift();
				if (next) applyUpdate(b, next, "replicate");
			}
			while (queueBtoA.length > 0) {
				const next = queueBtoA.shift();
				if (next) applyUpdate(a, next, "replicate");
			}
		},
	};
}

function withChildren(ir: PageIR, ids: readonly string[]): PageIR {
	return {
		...ir,
		root: {
			...ir.root,
			children: ids.map((id) => ({
				id,
				type: "Hero",
				props: { headline: `headline-${id}` },
			})),
		},
	};
}

describe("plugin-collab-yjs partition + reconnect", () => {
	it("edits made while disconnected merge cleanly on reconnect", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		const link = makePartitionableLink(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		// Both replicas start from the same baseline IR.
		const baseline = withChildren(createFakePageIR(), ["n-1"]);
		adapterA.save(baseline, { label: "baseline" });
		expect(adapterB.list().map((m) => m.label)).toEqual(["baseline"]);

		// Drop the link.
		link.disconnect();

		// Each side performs a divergent additive edit.
		const irOnA = withChildren(baseline, ["n-1", "n-2-from-alice"]);
		adapterA.save(irOnA, { label: "from-alice" });
		const irOnB = withChildren(baseline, ["n-1", "n-2-from-bob"]);
		adapterB.save(irOnB, { label: "from-bob" });

		// While disconnected, neither replica sees the other's new
		// snapshot, but both retain the shared baseline.
		expect(adapterA.list().map((m) => m.label)).toEqual([
			"baseline",
			"from-alice",
		]);
		expect(adapterB.list().map((m) => m.label)).toEqual([
			"baseline",
			"from-bob",
		]);

		// Restore the link. Snapshot metadata is stored by id, so
		// both offline snapshots survive. The live `pageIR` key still
		// uses deterministic LWW for the current canvas state.
		link.connect();

		const finalA = adapterA.list();
		const finalB = adapterB.list();
		expect(finalA).toEqual(finalB);
		expect(finalA.map((m) => m.label).sort()).toEqual([
			"baseline",
			"from-alice",
			"from-bob",
		]);
	});

	it("subscribe fires for queued remote edits the moment the link is restored", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		const link = makePartitionableLink(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const seenOnB: PageIR[] = [];
		const stop = adapterB.subscribe?.((ir) => seenOnB.push(ir));
		expect(typeof stop).toBe("function");

		link.disconnect();

		// Three offline edits on A. (No local edits on B — adding a
		// concurrent local write on B would race with A's queued
		// writes under Y.Map LWW and could leave B's view unchanged
		// after reconnect, masking whether the observer fired.)
		adapterA.save(withChildren(createFakePageIR(), ["a-1"]), {});
		adapterA.save(withChildren(createFakePageIR(), ["a-1", "a-2"]), {});
		adapterA.save(withChildren(createFakePageIR(), ["a-1", "a-2", "a-3"]), {});

		// While disconnected, B has not yet seen any of A's edits.
		expect(seenOnB).toEqual([]);

		link.connect();

		// On reconnect, B receives at least one remote update from A.
		// Yjs may collapse the three queued updates into a single
		// merged update, so we assert ≥ 1 (not exactly 3).
		expect(seenOnB.length).toBeGreaterThanOrEqual(1);
		// And the converged state on both sides agrees.
		expect(adapterA.list()).toEqual(adapterB.list());
		// B's last-observed IR includes A's accumulated state.
		const lastIR = seenOnB.at(-1);
		expect(lastIR?.root.children?.map((c) => c.id)).toEqual([
			"a-1",
			"a-2",
			"a-3",
		]);

		stop?.();
	});

	it("fires onConflict on reconnect when both replicas edited the same node while disconnected", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		const link = makePartitionableLink(docA, docB);

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

		// Shared baseline so node ids are known to both replicas.
		const baseline = withChildren(createFakePageIR(), ["hero-1"]);
		adapterA.save(baseline, { label: "baseline" });

		const eventsOnA: ConflictEvent[] = [];
		const eventsOnB: ConflictEvent[] = [];
		adapterA.onConflict((e) => eventsOnA.push(e));
		adapterB.onConflict((e) => eventsOnB.push(e));

		// Drop the link; both sides edit the same node concurrently.
		link.disconnect();
		// Distinct edits on the same node id so overlap fires on reconnect.
		const aliceEdit: PageIR = {
			...baseline,
			root: {
				...baseline.root,
				children: [
					{ id: "hero-1", type: "Hero", props: { headline: "alice-edit" } },
				],
			},
		};
		const bobEdit: PageIR = {
			...baseline,
			root: {
				...baseline.root,
				children: [
					{ id: "hero-1", type: "Hero", props: { headline: "bob-edit" } },
				],
			},
		};
		adapterA.save(aliceEdit, {});
		adapterB.save(bobEdit, {});

		// While the link is down, neither side has heard the other's
		// edit, so neither overlap event has fired yet.
		expect(eventsOnA).toEqual([]);
		expect(eventsOnB).toEqual([]);

		link.connect();

		// At least one side observes the overlap on reconnect. Yjs
		// resolves the legacy `pageIR` Y.Map key by deterministic LWW —
		// the *losing* replica sees its key flip to the winner's value
		// and fires the overlap event. The winning replica may not see
		// its key change at all (no Y.Map observe callback when the
		// merged value matches its existing value), so we don't pin
		// which specific side fires. The native-tree path (D1) emits
		// per-node merges for both sides.
		const total = eventsOnA.length + eventsOnB.length;
		expect(total).toBeGreaterThanOrEqual(1);
		const all = [...eventsOnA, ...eventsOnB];
		expect(all[0]?.kind).toBe("overlap");
		expect(all[0]?.nodeIds).toContain("hero-1");
		// Whoever fires, the localPeer must be self and remotePeer must
		// be the other side (or undefined if the legacy peer record
		// wasn't part of the same merge transaction).
		for (const event of all) {
			expect(event.kind).toBe("overlap");
			expect(["alice", "bob"]).toContain(event.localPeer.id);
			if (event.remotePeer) {
				expect(["alice", "bob"]).toContain(event.remotePeer.id);
				expect(event.remotePeer.id).not.toBe(event.localPeer.id);
			}
		}
	});

	it("repeated reconnects after silent windows produce no spurious local callbacks", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		const link = makePartitionableLink(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const seenOnA: PageIR[] = [];
		adapterA.subscribe?.((ir) => seenOnA.push(ir));

		// Three connect/disconnect cycles with only LOCAL edits on A.
		// A must never observe its own edits via its own subscribe.
		for (let i = 0; i < 3; i++) {
			link.disconnect();
			adapterA.save(withChildren(createFakePageIR(), [`a-${i}`]), {});
			link.connect();
		}

		expect(seenOnA).toEqual([]);
		// State on B converges to A's writes.
		expect(adapterB.list().map((m) => typeof m.id)).toEqual([
			"string",
			"string",
			"string",
		]);
	});
});
