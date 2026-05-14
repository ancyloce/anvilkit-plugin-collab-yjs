/**
 * @file L2 — snapshot diff API. Verifies `diffSnapshots` produces
 * usable structural diffs and that `createYjsAdapter({ computeDelta: true })`
 * attaches a `delta` to every `SnapshotMeta` returned by `list()`.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import { diffSnapshots } from "../diff.js";
import { createYjsAdapter } from "../yjs-adapter.js";

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

describe("diffSnapshots (L2)", () => {
	it("returns an empty diff for identical IRs", () => {
		const ir = withHero("v1");
		const diff = diffSnapshots(ir, ir);
		expect(diff).toEqual([]);
	});

	it("detects an added node", () => {
		const before = withHero("v1");
		const after: PageIR = {
			...before,
			root: {
				...before.root,
				children: [
					...(before.root.children ?? []),
					{ id: "hero-2", type: "Hero", props: { headline: "v2" } },
				],
			},
		};
		const diff = diffSnapshots(before, after);
		expect(diff.some((op) => op.kind === "add-node")).toBe(true);
	});

	it("detects a prop change", () => {
		const before = withHero("v1");
		const after = withHero("v2");
		const diff = diffSnapshots(before, after);
		const propChange = diff.find((op) => op.kind === "change-prop");
		expect(propChange).toBeDefined();
		if (propChange?.kind === "change-prop") {
			expect(propChange.key).toBe("headline");
			expect(propChange.before).toBe("v1");
			expect(propChange.after).toBe("v2");
		}
	});

	it("detects a removed node", () => {
		const before = withHero("v1");
		const after: PageIR = {
			...before,
			root: { ...before.root, children: [] },
		};
		const diff = diffSnapshots(before, after);
		expect(diff.some((op) => op.kind === "remove-node")).toBe(true);
	});
});

describe("createYjsAdapter({ computeDelta: true }) — L2 integration", () => {
	it("does not attach `delta` by default", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
		});
		adapter.save(withHero("v1"), {});
		const [meta] = adapter.list();
		expect(meta?.delta).toBeUndefined();
	});

	it("attaches `delta` to every snapshot when `computeDelta: true`", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
			computeDelta: true,
		});
		adapter.save(withHero("v1"), {});
		adapter.save(withHero("v2"), {});
		const metas = adapter.list();
		expect(metas).toHaveLength(2);
		for (const meta of metas) {
			expect(meta.delta).toBeDefined();
			expect(Array.isArray(meta.delta)).toBe(true);
		}
	});

	it("first save's delta is computed against the empty document", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
			computeDelta: true,
		});
		adapter.save(withHero("v1"), {});
		const [meta] = adapter.list();
		// At least one add-node op since the first save introduces nodes.
		const hasAdd = (meta?.delta ?? []).some((op) => op.kind === "add-node");
		expect(hasAdd).toBe(true);
	});

	it("subsequent save's delta reflects the property change", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
			computeDelta: true,
		});
		adapter.save(withHero("v1"), {});
		adapter.save(withHero("v2"), {});
		const metas = adapter.list();
		const second = metas[1];
		const propChange = (second?.delta ?? []).find(
			(op) => op.kind === "change-prop",
		);
		expect(propChange).toBeDefined();
		if (propChange?.kind === "change-prop") {
			expect(propChange.key).toBe("headline");
			expect(propChange.before).toBe("v1");
			expect(propChange.after).toBe("v2");
		}
	});

	it("caller-supplied `meta.delta` overrides the computed value", () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			peer: { id: "alice" },
			computeDelta: true,
		});
		const customDelta = [
			{
				kind: "change-prop" as const,
				path: "/root/children/0/props",
				key: "headline",
				before: "x",
				after: "y",
			},
		];
		adapter.save(withHero("v1"), { delta: customDelta });
		const [meta] = adapter.list();
		expect(meta?.delta).toEqual(customDelta);
	});
});
