/**
 * @file M12 / phase6-018 — `meta.locked` contention integration test.
 *
 * Pins the alpha-cycle behavior of the plugin against
 * `PageIRNode.meta.locked`:
 *
 *   - The CRDT layer is **content-blind**: it merges every update
 *     regardless of `meta.locked`. Yjs has no concept of node-level
 *     locks; enforcing them is the host's job.
 *
 *   - The plugin's `onDataChange` hook also does NOT enforce locks.
 *     If a host application wants lock semantics, it must wrap
 *     `dispatch` in a guard that drops mutating actions targeting a
 *     locked subtree (the demo's pattern in
 *     `apps/demo/lib/collab-demo.ts` will move there in a follow-up).
 *
 * The test below models that boundary directly: a "host dispatch
 * wrapper" sits between an incoming subscribe callback and the
 * downstream sink, and rejects updates that touch a locked node.
 * The CRDT state still converges; only the host-level downstream
 * consumer (Puck `setData`) is gated. This matches the contract
 * documented in `docs/architecture/realtime-collab.md` § "Behaviour
 * for `meta.locked` nodes during concurrent edits".
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import { createYjsAdapter } from "../yjs-adapter.js";

function pair(a: YDoc, b: YDoc): void {
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(b, update, "replicate");
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(a, update, "replicate");
	});
}

function withLockedHero(headline: string, locked: boolean): PageIR {
	const ir = createFakePageIR();
	const hero: PageIRNode = {
		id: "hero-1",
		type: "Hero",
		props: { headline },
		meta: { locked },
	};
	return { ...ir, root: { ...ir.root, children: [hero] } };
}

/**
 * Host-side guard: drop incoming updates that mutate the props of a
 * node that is locked in BOTH the previous and the next IR. Edits
 * that simultaneously unlock the node (i.e. `before.locked === true`
 * but `after.locked === false`) pass through — unlocking is itself
 * an authoritative action and the host does not split the write.
 * New nodes are always accepted (introducing a node isn't a
 * "mutation of a locked node" — there's nothing to mutate yet).
 * Returns `true` if the dispatch was accepted, `false` if dropped.
 */
function makeLockedGuard() {
	const events: Array<{ accepted: boolean; reason?: string }> = [];
	return {
		events,
		dispatch(prev: PageIR | undefined, next: PageIR): boolean {
			const prevById = new Map<string, PageIRNode>();
			for (const node of prev?.root.children ?? []) prevById.set(node.id, node);
			for (const after of next.root.children ?? []) {
				const before = prevById.get(after.id);
				if (!before) continue;
				const stillLocked = before.meta?.locked && after.meta?.locked;
				if (!stillLocked) continue;
				if (JSON.stringify(before.props) !== JSON.stringify(after.props)) {
					events.push({ accepted: false, reason: "LOCKED_NODE" });
					return false;
				}
			}
			events.push({ accepted: true });
			return true;
		},
	};
}

describe("plugin-collab-yjs lock contention (alpha)", () => {
	it("CRDT layer merges updates regardless of meta.locked", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		// A locks the hero. B writes a new headline anyway.
		adapterA.save(withLockedHero("baseline", true), { label: "lock-on" });
		adapterB.save(withLockedHero("from-bob", true), { label: "bob-edit" });

		// Both replicas converge to the same state — the lock did
		// NOT prevent CRDT merge.
		expect(adapterA.list()).toEqual(adapterB.list());
		const lastId = adapterA.list().at(-1)?.id;
		if (!lastId) throw new Error("expected at least one snapshot");
		const final = adapterA.load(lastId);
		expect(final.root.children?.[0]?.meta?.locked).toBe(true);
	});

	it("a host-level locked-node guard rejects mutating dispatches but lets the CRDT merge through", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const guard = makeLockedGuard();
		let dispatchedToPuckOnB: PageIR | undefined;
		let prevOnB: PageIR | undefined;

		adapterB.subscribe?.((ir) => {
			const accepted = guard.dispatch(prevOnB, ir);
			if (accepted) dispatchedToPuckOnB = ir;
			prevOnB = ir;
		});

		// Step 1: A publishes a baseline (unlocked). Guard accepts it.
		adapterA.save(withLockedHero("initial", false), {});

		// Step 2: A locks the hero. Guard accepts (no prop change).
		adapterA.save(withLockedHero("initial", true), {});
		expect(dispatchedToPuckOnB?.root.children?.[0]?.props.headline).toBe(
			"initial",
		);

		// Step 3: A mutates the headline of the now-locked hero.
		// Guard MUST drop it; downstream sink stays at "initial".
		adapterA.save(withLockedHero("mutated-while-locked", true), {});
		expect(dispatchedToPuckOnB?.root.children?.[0]?.props.headline).toBe(
			"initial",
		);

		// But the CRDT state itself merged the change.
		const lastId = adapterB.list().at(-1)?.id;
		if (!lastId) throw new Error("expected at least one snapshot");
		const finalIR = adapterB.load(lastId);
		expect(finalIR.root.children?.[0]?.props.headline).toBe(
			"mutated-while-locked",
		);

		// Guard saw exactly one rejection.
		const rejections = guard.events.filter((e) => !e.accepted);
		expect(rejections).toHaveLength(1);
		expect(rejections[0]?.reason).toBe("LOCKED_NODE");
	});

	it("unlocking the node lets subsequent edits flow through the guard", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const guard = makeLockedGuard();
		let dispatched: PageIR | undefined;
		let prev: PageIR | undefined;
		adapterB.subscribe?.((ir) => {
			if (guard.dispatch(prev, ir)) dispatched = ir;
			prev = ir;
		});

		adapterA.save(withLockedHero("v1", true), {});
		adapterA.save(withLockedHero("v2", true), {}); // dropped
		expect(dispatched?.root.children?.[0]?.props.headline).toBe("v1");

		adapterA.save(withLockedHero("v3", false), {}); // unlock + edit
		expect(dispatched?.root.children?.[0]?.props.headline).toBe("v3");
	});
});
