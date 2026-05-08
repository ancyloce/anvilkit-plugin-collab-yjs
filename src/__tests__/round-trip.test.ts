import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import { irToPuckData, puckDataToIR } from "@anvilkit/ir";
import type { Config } from "@puckeditor/core";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import { decodeIR, encodeIR } from "../encode.js";
import { readNativeTree } from "../native-tree.js";
import { createYjsAdapter } from "../yjs-adapter.js";

const STUB_CONFIG: Config = {
	components: {
		Hero: {
			fields: {
				headline: { type: "text" },
			},
			defaultProps: { headline: "Hello" },
			render: () => null,
		},
		Pricing: {
			fields: {
				tier: { type: "text" },
			},
			defaultProps: { tier: "Pro" },
			render: () => null,
		},
	},
} as unknown as Config;

function rngFactory(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0xffffffff;
	};
}

function pickComponent(rng: () => number): string {
	return rng() < 0.5 ? "Hero" : "Pricing";
}

function mutateIR(ir: PageIR, rng: () => number, step: number): PageIR {
	const action = Math.floor(rng() * 4);
	const existing = ir.root.children ?? [];

	if (action === 0 || existing.length === 0) {
		const id = `n-${step}`;
		const next: PageIRNode = {
			id,
			type: pickComponent(rng),
			props: { headline: `headline-${step}`, tier: `tier-${step}` },
		};
		return {
			...ir,
			root: {
				...ir.root,
				children: [...existing, next],
			},
		};
	}

	if (action === 1 && existing.length > 0) {
		const trimmed = existing.slice(0, existing.length - 1);
		return { ...ir, root: { ...ir.root, children: trimmed } };
	}

	if (action === 2 && existing.length > 0) {
		const idx = Math.floor(rng() * existing.length);
		const target = existing[idx];
		if (!target) return ir;
		const updated: PageIRNode = {
			...target,
			props: { ...target.props, headline: `mut-${step}` },
		};
		const nextChildren = existing.slice();
		nextChildren[idx] = updated;
		return { ...ir, root: { ...ir.root, children: nextChildren } };
	}

	if (action === 3 && existing.length > 1) {
		const next = existing.slice().reverse();
		return { ...ir, root: { ...ir.root, children: next } };
	}

	return ir;
}

function pairDocs(a: YDoc, b: YDoc): void {
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === "replicate") return;
		applyUpdate(b, update, "replicate");
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === "replicate") return;
		applyUpdate(a, update, "replicate");
	});
}

describe("plugin-collab-yjs round-trip", () => {
	it("encode/decode is lossless for a fresh PageIR", () => {
		const ir = createFakePageIR();
		const decoded = decodeIR(encodeIR(ir));
		expect(decoded).toEqual(ir);
	});

	it("encode is order-independent (sorted keys)", () => {
		const a: PageIR = {
			version: "1",
			root: { id: "r", type: "__root__", props: { a: 1, b: 2 } },
			assets: [],
			metadata: { createdAt: new Date(0).toISOString() },
		};
		const b: PageIR = {
			version: "1",
			assets: [],
			metadata: { createdAt: new Date(0).toISOString() },
			root: { props: { b: 2, a: 1 }, type: "__root__", id: "r" },
		};
		expect(encodeIR(a)).toBe(encodeIR(b));
	});

	it("CRDT ↔ IR ↔ Puck round-trip equivalence over 100 random edits", () => {
		const rng = rngFactory(0xc0ffee);
		const docA = new YDoc();
		const docB = new YDoc();
		pairDocs(docA, docB);

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		let ir = createFakePageIR();
		adapterA.save(ir, {});

		for (let step = 0; step < 100; step++) {
			ir = mutateIR(ir, rng, step);
			const writer = step % 2 === 0 ? adapterA : adapterB;
			writer.save(ir, {});

			const idsA = adapterA.list();
			const idsB = adapterB.list();
			expect(idsA).toEqual(idsB);
			const lastId = idsA[idsA.length - 1]?.id;
			expect(lastId).toBeDefined();
			if (!lastId) continue;

			const fromA = adapterA.load(lastId);
			const fromB = adapterB.load(lastId);
			expect(fromA).toEqual(fromB);
			expect(fromA).toEqual(ir);

			const puckA = irToPuckData(fromA);
			const puckB = irToPuckData(fromB);
			expect(puckA).toEqual(puckB);

			const reIR = puckDataToIR(puckA, STUB_CONFIG);
			expect(reIR.root.children?.length ?? 0).toBe(
				ir.root.children?.length ?? 0,
			);
		}
	});

	it("native Y.Map encoding round-trips through 100 random edits (D1 fuzz)", () => {
		const rng = rngFactory(0xdec0de);
		const docA = new YDoc();
		const docB = new YDoc();
		pairDocs(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			useNativeTree: true,
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			useNativeTree: true,
		});

		const treeMapName = "anvilkit-collab:tree";
		let ir = createFakePageIR();
		adapterA.save(ir, {});

		for (let step = 0; step < 100; step++) {
			ir = mutateIR(ir, rng, step);
			const writer = step % 2 === 0 ? adapterA : adapterB;
			writer.save(ir, {});

			// Both replicas reconstruct the same IR from the live native
			// tree — this is the per-node CRDT mirror, not the legacy
			// JSON blob.
			const fromTreeA = readNativeTree(docA.getMap<unknown>(treeMapName));
			const fromTreeB = readNativeTree(docB.getMap<unknown>(treeMapName));
			expect(fromTreeA).toBeDefined();
			expect(fromTreeB).toBeDefined();
			expect(fromTreeA).toEqual(fromTreeB);
			// And the reconstructed IR matches the IR last written by
			// the most recent author. Fuzz mutations exercise add /
			// remove / mutate-prop / reverse — every shape must survive
			// the encode → Yjs → decode round-trip.
			expect(fromTreeA?.root.id).toBe(ir.root.id);
			const treeChildIds = (fromTreeA?.root.children ?? []).map(
				(c) => c.id,
			);
			const irChildIds = (ir.root.children ?? []).map((c) => c.id);
			expect(treeChildIds).toEqual(irChildIds);
			// Snapshot list still converges on the legacy path.
			expect(adapterA.list()).toEqual(adapterB.list());
		}
	});
});
