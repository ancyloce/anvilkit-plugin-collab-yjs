import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it, vi } from "vitest";
import { applyUpdate, encodeStateAsUpdate, Doc as YDoc } from "yjs";

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

function withHero(text: string): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [{ id: "hero-1", type: "Hero", props: { text } }],
		},
	};
}

function withHero2(headline: string, description: string): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [
				{ id: "hero-1", type: "Hero", props: { headline, description } },
			],
		},
	};
}

describe("createYjsAdapter conflict window (M2)", () => {
	it("fires a conflict even after a burst of local saves keeps lastLocalSavedAt fresh", () => {
		vi.useFakeTimers();
		try {
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

			const events: ConflictEvent[] = [];
			adapterA.onConflict((e) => events.push(e));

			// Alice fires 49 rapid saves (every 100ms) — under the OLD
			// implementation, this kept `lastLocalSavedAt` glued to the
			// "now" cursor, so the conflict-detection window (measured
			// from lastLocalSavedAt) would suppress a conflict if Bob's
			// edit landed even 4900ms after Alice's FIRST save. The fix
			// measures from firstUnconfirmedLocalSaveAt instead.
			for (let i = 0; i < 49; i += 1) {
				adapterA.save(withHero(`alice-${i}`), {});
				vi.advanceTimersByTime(100);
			}
			// t = 4900ms; Bob lands a concurrent edit on the same node.
			adapterB.save(withHero("bob-overlap"), {});

			expect(events.length).toBeGreaterThanOrEqual(1);
			expect(events[0]?.nodeIds).toContain("hero-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT false-positive on disjoint props when the baseline is seeded from a loaded document (Fix A)", () => {
		// A participant joining an EXISTING document: the adapter is
		// constructed against a doc that already has content, so the
		// conflict baseline is seeded (Fix A). The user's first edit
		// then takes the three-way (baseline-anchored) path instead of
		// the divergence-as-conflict fallback. Two peers editing
		// DIFFERENT props of the same node merge cleanly under the
		// native-tree CRDT and must NOT report an overlap.
		//
		// Exchange is one-directional and manual (no `pair`) so the two
		// edits stay genuinely concurrent: `applyIRToNativeTree` diffs
		// against each peer's seeded baseline and writes only the prop
		// that peer changed, so the keys never contend.
		const docSeed = new YDoc();
		const seed = createYjsAdapter({ doc: docSeed, peer: { id: "seed" } });
		seed.save(withHero2("h0", "d0"), {});
		const seedState = encodeStateAsUpdate(docSeed);

		const docA = new YDoc();
		applyUpdate(docA, seedState);
		const docB = new YDoc();
		applyUpdate(docB, seedState);

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
		const events: ConflictEvent[] = [];
		adapterA.onConflict((e) => events.push(e));

		// Alice edits headline only (docA); Bob concurrently edits
		// description only (docB) — each adapter's seeded baseline makes
		// `applyIRToNativeTree` write just the one changed key. Then
		// Bob's description-only update lands on Alice.
		adapterA.save(withHero2("h1", "d0"), {});
		adapterB.save(withHero2("h0", "d1"), {});
		applyUpdate(docA, encodeStateAsUpdate(docB), "replicate");

		expect(events).toEqual([]);
	});

	it("still fires on a genuine same-prop concurrent edit with a seeded baseline (Fix A)", () => {
		const docSeed = new YDoc();
		const seed = createYjsAdapter({ doc: docSeed, peer: { id: "seed" } });
		seed.save(withHero2("h0", "d0"), {});
		const seedState = encodeStateAsUpdate(docSeed);

		const docA = new YDoc();
		applyUpdate(docA, seedState);
		const docB = new YDoc();
		applyUpdate(docB, seedState);

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
		const events: ConflictEvent[] = [];
		adapterA.onConflict((e) => events.push(e));

		// Sequentialize on the SAME prop so Bob's write deterministically
		// wins LWW on Alice's doc: Alice edits description; Bob sees it,
		// then edits description again. Both diverge from the seeded
		// baseline → a true conflict the shield must still report.
		adapterA.save(withHero2("h0", "alice-desc"), {});
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");
		adapterB.save(withHero2("h0", "bob-desc"), {});
		applyUpdate(docA, encodeStateAsUpdate(docB), "replicate");

		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events[0]?.nodeIds).toContain("hero-1");
	});

	it("does NOT fire when remote arrives past staleAfterMs since the FIRST local save", () => {
		vi.useFakeTimers();
		try {
			const docA = new YDoc();
			const docB = new YDoc();
			pair(docA, docB);

			const adapterA = createYjsAdapter({
				doc: docA,
				peer: { id: "alice" },
				staleAfterMs: 1000,
			});
			const adapterB = createYjsAdapter({
				doc: docB,
				peer: { id: "bob" },
				staleAfterMs: 1000,
			});
			const events: ConflictEvent[] = [];
			adapterA.onConflict((e) => events.push(e));

			adapterA.save(withHero("alice-first"), {});
			vi.advanceTimersByTime(2000); // past staleAfterMs
			adapterB.save(withHero("bob-late"), {});

			expect(events).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
