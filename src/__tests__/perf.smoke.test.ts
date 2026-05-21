import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createYjsAdapter } from "../utils/yjs-adapter.js";

/**
 * Coarse wall-clock guard so a CATASTROPHIC high-load regression fails
 * `pnpm test` even without the precise `bench/` job. Budgets are
 * deliberately generous (machine-sensitive) — `bench/plugin-collab-yjs`
 * is the real trend/regression gate. This only catches order-of-
 * magnitude blowups (e.g. a re-introduced O(document) per-edit cost).
 */
const NODE_COUNT = 2000;

function make2000NodeIR(): PageIR {
	const children = Array.from({ length: NODE_COUNT }, (_, i) => ({
		id: `n-${i}`,
		type: "Block",
		props: { title: `Block ${i}`, index: i },
	}));
	return {
		version: "1",
		root: { id: "root", type: "Root", props: {}, children },
		assets: [],
		metadata: {},
	} as PageIR;
}

// Cheap structural-share clone: only the changed node gets a new
// object so the harness itself isn't an O(document) deep clone that
// would dwarf the adapter cost we're trying to bound.
function mutate(ir: PageIR, counter: number): PageIR {
	const idx = counter % NODE_COUNT;
	const children = (ir.root.children ?? []).slice() as {
		props: Record<string, unknown>;
	}[];
	const old = children[idx];
	if (old) {
		children[idx] = {
			...old,
			props: { ...old.props, title: `edited-${counter}` },
		} as (typeof children)[number];
	}
	return {
		...ir,
		root: { ...ir.root, children },
	} as PageIR;
}

describe("plugin-collab-yjs high-load smoke", () => {
	it("sustains 50 single-prop saves on a 2000-node doc well under budget", () => {
		const adapter = createYjsAdapter({
			doc: new Y.Doc(),
			peer: { id: "smoke" },
		});
		const base = make2000NodeIR();
		adapter.save(base, {});
		const start = performance.now();
		for (let i = 1; i <= 50; i += 1) adapter.save(mutate(base, i), {});
		const elapsed = performance.now() - start;
		adapter.destroy();
		// I1/§3.1 — a non-structural save now applies ONLY the changed
		// node to the native tree (O(changed)) instead of walking all
		// 2000 (byte-identical: unchanged-node writeNode was a no-op).
		// The residual per-save cost is the O(document) encode+hash for
		// the snapshot payload/pageIRHash (kept by contract). Observed
		// well under 10ms/save after the fix; the previous 80ms/save
		// (full O(document) native-apply) is the regression this floor
		// now catches. 1500ms total is ~4× headroom over the observed
		// ~350ms while still failing loudly if the O(document)
		// native-apply is reintroduced (~4000ms+).
		expect(elapsed).toBeLessThan(1500);
	});

	it("applies 50 remote single-prop updates incrementally under budget", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const a = createYjsAdapter({ doc: docA, peer: { id: "a" } });
		const b = createYjsAdapter({ doc: docB, peer: { id: "b" } });
		let emitted = 0;
		a.subscribe(() => {
			emitted += 1;
		});
		const base = make2000NodeIR();
		b.save(base, {});
		Y.applyUpdateV2(docA, Y.encodeStateAsUpdateV2(docB), { id: "seed" });
		const start = performance.now();
		for (let i = 1; i <= 50; i += 1) {
			const sv = Y.encodeStateVector(docA);
			b.save(mutate(base, i), {});
			Y.applyUpdateV2(docA, Y.encodeStateAsUpdateV2(docB, sv), {
				id: "remote",
			});
		}
		const elapsed = performance.now() - start;
		a.destroy();
		b.destroy();
		expect(emitted).toBeGreaterThan(0);
		// Remote path: B's save encode + Yjs update + A's incremental
		// live-IR reconstruct + emit. Generous catastrophe floor.
		expect(elapsed).toBeLessThan(5000);
	});
});
