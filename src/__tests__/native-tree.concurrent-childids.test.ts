/**
 * I5 (P0) — CRDT structural-merge correctness for child-id arrays.
 *
 * The old `reconcileChildIds` did `delete(0,len)+insert(0,desired)` on
 * any change. Two replicas concurrently editing the same parent's
 * `childIds` then each replaced the whole `Y.Array`; Yjs converges but
 * to a garbled union (duplicated/dropped children). These tests pair
 * two docs, apply concurrent DISJOINT structural edits, merge both
 * ways, and assert (a) the replicas converge and (b) the disjoint
 * intents both survive without duplication.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc, encodeStateAsUpdate } from "yjs";

import { applyIRToNativeTree, readNativeTree } from "../native-tree.js";

const TREE_MAP = "anvilkit-collab:tree";

function pair(a: YDoc, b: YDoc): void {
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(b, update, "replicate");
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(a, update, "replicate");
	});
}

function withChildren(
	ids: ReadonlyArray<{ id: string; props?: Record<string, unknown> }>,
): PageIR {
	const base = createFakePageIR();
	const children: PageIRNode[] = ids.map(({ id, props }) => ({
		id,
		type: "Block",
		props: props ?? { label: id },
	}));
	return { ...base, root: { ...base.root, children } };
}

function tree(doc: YDoc): PageIR | undefined {
	return readNativeTree(doc.getMap<unknown>(TREE_MAP));
}

function childIds(ir: PageIR | undefined): string[] {
	return (ir?.root.children ?? []).map((c) => c.id);
}

function write(doc: YDoc, ir: PageIR, baseline: PageIR | undefined): void {
	doc.transact(() => {
		applyIRToNativeTree(doc.getMap<unknown>(TREE_MAP), ir, baseline);
	});
}

describe("reconcileChildIds — concurrent structural merge (I5)", () => {
	it("preserves concurrent disjoint child INSERTS from two peers", () => {
		const docA = new YDoc();
		const docB = new YDoc();

		const base = withChildren([{ id: "n1" }, { id: "n2" }]);
		write(docA, base, undefined);
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");

		// Concurrent, BEFORE pairing: A appends a1, B appends b1.
		write(docA, withChildren([{ id: "n1" }, { id: "n2" }, { id: "a1" }]), base);
		write(docB, withChildren([{ id: "n1" }, { id: "n2" }, { id: "b1" }]), base);

		pair(docA, docB);
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");
		applyUpdate(docA, encodeStateAsUpdate(docB), "replicate");

		const a = tree(docA);
		const b = tree(docB);
		// Convergence.
		expect(a).toEqual(b);
		// Both disjoint inserts survived; original ids intact; no dupes.
		const ids = childIds(a);
		expect([...ids].sort()).toEqual(["a1", "b1", "n1", "n2"]);
		expect(ids.length).toBe(new Set(ids).size); // no duplicates
		// Every child id resolves to a real node (not a dangling id).
		for (const c of a?.root.children ?? []) {
			expect(typeof c.type).toBe("string");
		}
	});

	it("preserves a remote child REMOVE concurrent with a local REORDER", () => {
		const docA = new YDoc();
		const docB = new YDoc();

		const base = withChildren([{ id: "n1" }, { id: "n2" }, { id: "n3" }]);
		write(docA, base, undefined);
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");

		// A removes n2; B reorders to [n3,n1,n2] — disjoint intents.
		write(docA, withChildren([{ id: "n1" }, { id: "n3" }]), base);
		write(docB, withChildren([{ id: "n3" }, { id: "n1" }, { id: "n2" }]), base);

		pair(docA, docB);
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");
		applyUpdate(docA, encodeStateAsUpdate(docB), "replicate");

		const a = tree(docA);
		const b = tree(docB);
		expect(a).toEqual(b); // converge
		const ids = childIds(a);
		expect(ids).not.toContain("n2"); // A's remove won
		expect([...ids].sort()).toEqual(["n1", "n3"]);
		expect(ids.length).toBe(new Set(ids).size);
	});

	it("a remote child INSERT survives a concurrent local prop edit", () => {
		const docA = new YDoc();
		const docB = new YDoc();

		const base = withChildren([
			{ id: "n1", props: { label: "base" } },
			{ id: "n2", props: { label: "base" } },
		]);
		write(docA, base, undefined);
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");

		// A inserts n3 (structural) WITHOUT touching n1/n2 props, so the
		// only concurrent prop write is B's — a truly disjoint edit.
		write(
			docA,
			withChildren([
				{ id: "n1", props: { label: "base" } },
				{ id: "n2", props: { label: "base" } },
				{ id: "n3" },
			]),
			base,
		);
		write(
			docB,
			withChildren([
				{ id: "n1", props: { label: "B-edited" } },
				{ id: "n2", props: { label: "base" } },
			]),
			base,
		);

		pair(docA, docB);
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");
		applyUpdate(docA, encodeStateAsUpdate(docB), "replicate");

		const a = tree(docA);
		expect(a).toEqual(tree(docB)); // converge
		expect([...childIds(a)].sort()).toEqual(["n1", "n2", "n3"]); // A's insert
		const n1 = a?.root.children?.find((c) => c.id === "n1");
		expect(n1?.props.label).toBe("B-edited"); // B's disjoint prop edit
	});

	it("single-peer reorder / insert / remove still reads back correctly", () => {
		const doc = new YDoc();
		const base = withChildren([{ id: "n1" }, { id: "n2" }, { id: "n3" }]);
		write(doc, base, undefined);
		expect(childIds(tree(doc))).toEqual(["n1", "n2", "n3"]);

		// reorder
		const reordered = withChildren([{ id: "n3" }, { id: "n1" }, { id: "n2" }]);
		write(doc, reordered, base);
		expect(childIds(tree(doc))).toEqual(["n3", "n1", "n2"]);

		// insert in the middle
		const inserted = withChildren([
			{ id: "n3" },
			{ id: "n4" },
			{ id: "n1" },
			{ id: "n2" },
		]);
		write(doc, inserted, reordered);
		expect(childIds(tree(doc))).toEqual(["n3", "n4", "n1", "n2"]);

		// remove
		const removed = withChildren([{ id: "n3" }, { id: "n1" }, { id: "n2" }]);
		write(doc, removed, inserted);
		expect(childIds(tree(doc))).toEqual(["n3", "n1", "n2"]);
	});
});
