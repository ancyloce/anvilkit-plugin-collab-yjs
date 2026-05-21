import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createLiveIRState } from "../utils/live-ir.js";
import {
	applyIRToNativeTree,
	type ReadGuardTrip,
	readNativeTree,
} from "../utils/native-tree.js";

function ir(children: { id: string; title: string }[]): PageIR {
	return {
		version: "1",
		root: {
			id: "root",
			type: "Root",
			props: {},
			children: children.map((c) => ({
				id: c.id,
				type: "Block",
				props: { title: c.title },
			})),
		},
		assets: [],
		metadata: { title: "doc" },
	} as PageIR;
}

describe("createLiveIRState (H3)", () => {
	it("setLocal then get() returns a structurally-equal independent tree", () => {
		const live = createLiveIRState();
		const a = ir([{ id: "n1", title: "one" }]);
		live.setLocal(a);
		const got = live.get();
		expect(got).toEqual(a);
		expect(got).not.toBe(a); // fresh — no aliasing into conflicts
	});

	it("incremental apply matches a full readNativeTree after a prop edit", () => {
		const doc = new Y.Doc();
		const tree = doc.getMap<unknown>("t");
		const v1 = ir([
			{ id: "n1", title: "one" },
			{ id: "n2", title: "two" },
		]);
		applyIRToNativeTree(tree, v1, undefined);
		const live = createLiveIRState();
		// Seed (structural / first read).
		expect(live.applyRemoteChangedNodes(tree, new Set(), true)).toEqual(v1);

		const v2 = ir([
			{ id: "n1", title: "one" },
			{ id: "n2", title: "two-edited" },
		]);
		applyIRToNativeTree(tree, v2, v1);
		const incremental = live.applyRemoteChangedNodes(
			tree,
			new Set(["n2"]),
			false,
		);
		expect(incremental).toEqual(readNativeTree(tree));
		expect(incremental).toEqual(v2);
	});

	it("P1 — relink (reorder/add/remove) matches a full rebuild without re-parsing untouched nodes", () => {
		const doc = new Y.Doc();
		const tree = doc.getMap<unknown>("t");
		const v1 = ir([
			{ id: "n1", title: "one" },
			{ id: "n2", title: "two" },
			{ id: "n3", title: "three" },
		]);
		applyIRToNativeTree(tree, v1, undefined);
		const live = createLiveIRState();
		live.applyRemoteChangedNodes(tree, new Set(), true); // seed

		// Reorder + add + remove in one step: [n1,n2,n3] → [n3,n1,n4]
		const v2 = ir([
			{ id: "n3", title: "three" },
			{ id: "n1", title: "one" },
			{ id: "n4", title: "four" },
		]);
		applyIRToNativeTree(tree, v2, v1);

		// Adapter-derived relink for this edit: root's childIds changed,
		// n4 added at root, n2 removed at root.
		const out = live.applyRemoteChangedNodes(
			tree,
			new Set(["root", "n4", "n2"]),
			false,
			{
				addedIds: new Set(["n4"]),
				removedIds: new Set(["n2"]),
				parentsTouched: new Set(["root"]),
			},
		);
		expect(out).toEqual(readNativeTree(tree));
		expect(out).toEqual(v2);
	});

	it("falls back to a full rebuild on a structural change", () => {
		const doc = new Y.Doc();
		const tree = doc.getMap<unknown>("t");
		const v1 = ir([{ id: "n1", title: "one" }]);
		applyIRToNativeTree(tree, v1, undefined);
		const live = createLiveIRState();
		live.applyRemoteChangedNodes(tree, new Set(), true);

		const v2 = ir([
			{ id: "n1", title: "one" },
			{ id: "n2", title: "two" },
		]);
		applyIRToNativeTree(tree, v2, v1);
		const out = live.applyRemoteChangedNodes(tree, new Set(["root"]), true);
		expect(out).toEqual(readNativeTree(tree));
		expect(out).toEqual(v2);
	});

	it("trips the guard (and degrades) on a cyclic remote tree", () => {
		const doc = new Y.Doc();
		const tree = doc.getMap<unknown>("t");
		tree.set("version", "1");
		tree.set("rootId", "r");
		const node = new Y.Map<unknown>();
		node.set("type", "Root");
		const childIds = new Y.Array<string>();
		childIds.insert(0, ["r"]); // self-cycle
		node.set("childIds", childIds);
		tree.set("node:r", node);

		const onGuardTrip = vi.fn<(reason: ReadGuardTrip) => void>();
		const live = createLiveIRState({ onGuardTrip });
		// Must terminate (not stack-overflow) and report the cycle.
		const out = live.applyRemoteChangedNodes(tree, new Set(), true);
		expect(onGuardTrip).toHaveBeenCalledWith("cycle");
		// Root decodes; the cyclic child is dropped.
		expect(out?.root.id).toBe("r");
		expect(out?.root.children ?? []).toHaveLength(0);
	});
});
