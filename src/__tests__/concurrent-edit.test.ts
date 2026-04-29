/**
 * @file M12 / phase6-018 — concurrent edit convergence test.
 *
 * Two adapters share a Y.Doc bidirectionally. They issue divergent
 * concurrent writes targeting the same node, the same prop key, and
 * disjoint prop keys on the same node. The test pins the alpha-cycle
 * convergence guarantees:
 *
 *   1. After both writes propagate, both replicas observe the same
 *      converged state (CRDT convergence).
 *   2. For overlapping writes (same prop key), Yjs Y.Map LWW resolves
 *      to a single deterministic value — neither side wins
 *      systematically across runs, but the two replicas always agree.
 *   3. The order of `subscribe()` callbacks matches the order
 *      observed in Yjs's transaction log — no out-of-order delivery
 *      across the in-process link.
 *
 * Note: with the alpha JSON-blob encoding, Yjs sees one Y.Map key
 * (`pageIR`) per write, so concurrent writes are LWW on the WHOLE
 * PageIR — not per-prop. The "disjoint prop key" assertion is still
 * useful because it pins this alpha behavior; the GA plan
 * (mirroring the IR tree natively in Y) will tighten it to per-prop
 * merge.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
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

describe("plugin-collab-yjs concurrent edits", () => {
	it("two replicas writing to the same node converge to a single state", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		// Same starting point on both sides.
		adapterA.save(withHero({ headline: "baseline" }), {});

		// Concurrent writes (interleaved at the docs level — Yjs
		// transactions are serialized through `update` events).
		adapterA.save(withHero({ headline: "from-alice" }), {});
		adapterB.save(withHero({ headline: "from-bob" }), {});

		const finalA = adapterA.list();
		const finalB = adapterB.list();
		expect(finalA).toEqual(finalB);

		const winnerId = finalA[finalA.length - 1]?.id;
		expect(winnerId).toBeDefined();
		if (!winnerId) return;
		const irA = adapterA.load(winnerId);
		const irB = adapterB.load(winnerId);
		expect(irA).toEqual(irB);
		expect(["from-alice", "from-bob"]).toContain(
			irA.root.children?.[0]?.props.headline,
		);
	});

	it("disjoint prop keys on the same node — LWW collapses to one writer (alpha)", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		adapterA.save(withHero({ headline: "shared", subtitle: "shared" }), {});

		// A edits headline; B edits subtitle. With JSON-blob encoding,
		// the two writes race on the SAME Y.Map key (`pageIR`).
		adapterA.save(withHero({ headline: "alice-headline", subtitle: "shared" }), {});
		adapterB.save(withHero({ headline: "shared", subtitle: "bob-subtitle" }), {});

		const finalA = adapterA.list();
		const finalB = adapterB.list();
		expect(finalA).toEqual(finalB);

		const winnerId = finalA[finalA.length - 1]?.id;
		if (!winnerId) throw new Error("expected at least one snapshot");

		const irA = adapterA.load(winnerId);
		const props = irA.root.children?.[0]?.props as Record<string, unknown>;

		// Alpha behavior: only ONE side's edits survive (LWW on the
		// whole IR blob). At least one of the two edits is preserved;
		// the OTHER one is overwritten. Both replicas see the same
		// outcome.
		const headlineFromAlice = props.headline === "alice-headline";
		const subtitleFromBob = props.subtitle === "bob-subtitle";
		expect(headlineFromAlice || subtitleFromBob).toBe(true);
		// They must not BOTH be true under JSON-blob alpha encoding —
		// that would imply per-prop merge, which is the GA target.
		// The test asserts the documented limitation explicitly so a
		// future native-tree encoding will trip and demand a migration
		// note.
		expect(headlineFromAlice && subtitleFromBob).toBe(false);
	});

	it("subscribe delivery is ordered consistently with the local transaction log", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const seen: string[] = [];
		adapterB.subscribe?.((ir) => {
			const headline = ir.root.children?.[0]?.props.headline;
			if (typeof headline === "string") seen.push(headline);
		});

		adapterA.save(withHero({ headline: "first" }), {});
		adapterA.save(withHero({ headline: "second" }), {});
		adapterA.save(withHero({ headline: "third" }), {});

		expect(seen).toEqual(["first", "second", "third"]);
	});
});
