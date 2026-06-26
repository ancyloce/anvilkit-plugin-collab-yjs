/**
 * §4.2.3 — semantic conflict resolution for same-node, same-FIELD edits.
 *
 * Builds on the existing conflict-event machinery (conflict.test.ts /
 * concurrent-edit.test.ts). Two peers race on the SAME prop key of the
 * SAME node; the adapter must:
 *
 *   1. Emit a RICHER `ConflictEvent` whose `fields` names the conflicting
 *      prop key and carries the local vs remote values (so a host can
 *      present a semantic merge instead of "your unsaved change overlapped").
 *   2. When a host supplies a `resolveConflict` merge-strategy hook, honor
 *      the chosen resolution and write it back into the shared doc —
 *      overriding pure last-write-wins and replicating to every peer.
 *   3. Leave default behavior (LWW + the existing overlap event) untouched
 *      when no hook is supplied.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import type { ConflictEvent } from "../types/types.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

function pair(a: YDoc, b: YDoc): void {
	a.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(b, u, "replicate");
	});
	b.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(a, u, "replicate");
	});
}

function withHero(props: Readonly<Record<string, unknown>>): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [{ id: "hero-1", type: "Hero", props }],
		},
	};
}

function heroHeadline(ir: PageIR): unknown {
	return ir.root.children?.[0]?.props.headline;
}

describe("createYjsAdapter §4.2.3 semantic conflict resolution", () => {
	it("emits richer conflict payload naming the conflicting field + local/remote values", () => {
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

		// Shared baseline so both replicas know the pre-edit state.
		adapterA.save(withHero({ headline: "shared", description: "shared" }), {});
		adapterB.save(withHero({ headline: "shared", description: "shared" }), {});

		const events: ConflictEvent[] = [];
		adapterA.onConflict((e) => events.push(e));

		// Concurrent SAME-field edits: both race on `headline`. Bob's save
		// is sequenced after Alice's (and after he received hers), so it
		// wins Y.Map LWW — remote = "bob-typed", local = "alice-typed".
		adapterA.save(
			withHero({ headline: "alice-typed", description: "shared" }),
			{},
		);
		adapterB.save(
			withHero({ headline: "bob-typed", description: "shared" }),
			{},
		);

		expect(events.length).toBeGreaterThanOrEqual(1);
		const event = events[0];
		expect(event?.nodeIds).toContain("hero-1");
		// Richer payload: the conflicting FIELD is named with both values.
		const fields = event?.fields ?? [];
		const headlineConflict = fields.find(
			(f) => f.nodeId === "hero-1" && f.field === "headline",
		);
		expect(headlineConflict).toBeDefined();
		expect(headlineConflict?.localValue).toBe("alice-typed");
		expect(headlineConflict?.remoteValue).toBe("bob-typed");
		// The disjoint, cleanly-merged `description` must NOT be reported.
		expect(fields.some((f) => f.field === "description")).toBe(false);
	});

	it("honors a resolveConflict hook returning 'local' — local value wins in the doc on BOTH peers", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			staleAfterMs: 5000,
			resolveConflict: () => "local",
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			staleAfterMs: 5000,
		});

		adapterA.save(withHero({ headline: "shared" }), {});
		adapterB.save(withHero({ headline: "shared" }), {});

		const seenA: unknown[] = [];
		const seenB: unknown[] = [];
		adapterA.subscribe?.((ir) => seenA.push(heroHeadline(ir)));
		adapterB.subscribe?.((ir) => seenB.push(heroHeadline(ir)));

		adapterA.save(withHero({ headline: "alice-typed" }), {});
		adapterB.save(withHero({ headline: "bob-typed" }), {});

		// Alice's hook re-asserted her value over Bob's LWW win; it must be
		// written back into the doc and replicated to Bob.
		expect(seenA.at(-1)).toBe("alice-typed");
		expect(seenB.at(-1)).toBe("alice-typed");

		// Prove the resolution is in the shared doc (not just a transient
		// emit): the newest snapshot reconstructs to Alice's value, and the
		// replica agrees.
		const latestId = adapterA.list().at(-1)?.id;
		expect(latestId).toBeDefined();
		if (latestId) {
			expect(heroHeadline(adapterA.load(latestId))).toBe("alice-typed");
			expect(heroHeadline(adapterB.load(latestId))).toBe("alice-typed");
		}
	});

	it("honors a field-level merge object — only listed fields are overwritten", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			staleAfterMs: 5000,
			resolveConflict: () => ({
				fields: { "hero-1": { headline: "merged-by-host" } },
			}),
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			staleAfterMs: 5000,
		});

		adapterA.save(withHero({ headline: "shared" }), {});
		adapterB.save(withHero({ headline: "shared" }), {});

		const seenB: unknown[] = [];
		adapterB.subscribe?.((ir) => seenB.push(heroHeadline(ir)));

		adapterA.save(withHero({ headline: "alice-typed" }), {});
		adapterB.save(withHero({ headline: "bob-typed" }), {});

		expect(seenB.at(-1)).toBe("merged-by-host");
	});

	it("default behavior unchanged when no hook supplied — LWW remote value wins", () => {
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

		adapterA.save(withHero({ headline: "shared" }), {});
		adapterB.save(withHero({ headline: "shared" }), {});

		const events: ConflictEvent[] = [];
		const seenA: unknown[] = [];
		adapterA.onConflict((e) => events.push(e));
		adapterA.subscribe?.((ir) => seenA.push(heroHeadline(ir)));

		adapterA.save(withHero({ headline: "alice-typed" }), {});
		adapterB.save(withHero({ headline: "bob-typed" }), {});

		// The overlap event still fires (existing machinery), and with no
		// resolveConflict hook the converged value stays Bob's LWW win — no
		// extra write-back happened.
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(seenA.at(-1)).toBe("bob-typed");
	});
});
