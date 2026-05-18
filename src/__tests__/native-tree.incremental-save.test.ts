/**
 * Stage 4a / I1 §3.1 — incremental local save.
 *
 * `diffIRNodesForLocalSave` must classify topology changes as
 * `structural` (→ full `applyIRToNativeTree`) and pure prop edits as
 * non-structural (→ O(changed) `applyChangedNodesToNativeTree`). The
 * incremental path must be byte-equivalent: a remote peer replicating
 * the Y.Doc must read back exactly the locally-saved IR after a mix
 * of non-structural and structural saves.
 */

import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import { diffIRNodesForLocalSave } from "../native-tree.js";
import { createYjsAdapter } from "../yjs-adapter.js";

function doc(children: PageIR["root"]["children"]): PageIR {
	return {
		version: "1",
		root: { id: "root", type: "Root", props: {}, children },
		assets: [],
		metadata: {},
	} as PageIR;
}
const n = (id: string, t: string) => ({ id, type: "Hero", props: { t } });

describe("diffIRNodesForLocalSave — classification", () => {
	it("treats a missing prior IR as structural", () => {
		expect(
			diffIRNodesForLocalSave(undefined, doc([n("a", "0")])).structural,
		).toBe(true);
	});

	it("a pure prop edit is non-structural with exactly the changed id", () => {
		const prev = doc([n("a", "0"), n("b", "0")]);
		const next = doc([n("a", "0"), n("b", "1")]);
		const d = diffIRNodesForLocalSave(prev, next);
		expect(d.structural).toBe(false);
		expect([...d.changed.keys()]).toEqual(["b"]);
		expect(d.baseline.get("b")?.props).toEqual({ t: "0" });
	});

	it("adding or removing a node is structural", () => {
		const prev = doc([n("a", "0")]);
		expect(
			diffIRNodesForLocalSave(prev, doc([n("a", "0"), n("b", "0")])).structural,
		).toBe(true);
		expect(
			diffIRNodesForLocalSave(doc([n("a", "0"), n("b", "0")]), prev).structural,
		).toBe(true);
	});

	it("reordering children (childIds membership/order) is structural", () => {
		const prev = doc([n("a", "0"), n("b", "0")]);
		const next = doc([n("b", "0"), n("a", "0")]);
		expect(diffIRNodesForLocalSave(prev, next).structural).toBe(true);
	});

	it("a type change is non-structural (node-local, via writeNode)", () => {
		const prev = doc([n("a", "0")]);
		const next = doc([{ id: "a", type: "Banner", props: { t: "0" } }]);
		const d = diffIRNodesForLocalSave(prev, next);
		expect(d.structural).toBe(false);
		expect([...d.changed.keys()]).toEqual(["a"]);
	});
});

describe("incremental local save — replicated peer convergence", () => {
	it("a remote peer reads back exactly the locally-saved IR after mixed saves", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		docA.on("update", (u: Uint8Array, o: unknown) => {
			if (o !== "replicate") applyUpdate(docB, u, "replicate");
		});
		const a = createYjsAdapter({ doc: docA, peer: { id: "a" } });
		const b = createYjsAdapter({ doc: docB, peer: { id: "b" } });
		const seen: PageIR[] = [];
		b.subscribe((ir) => seen.push(ir));

		// 1) structural seed
		a.save(doc([n("x", "0"), n("y", "0"), n("z", "0")]), {});
		// 2) non-structural prop edits (incremental path)
		a.save(doc([n("x", "1"), n("y", "0"), n("z", "0")]), {});
		a.save(doc([n("x", "1"), n("y", "2"), n("z", "0")]), {});
		// 3) structural: remove a node (full-apply fallback)
		a.save(doc([n("x", "1"), n("z", "0")]), {});
		// 4) non-structural again after the structural change
		a.save(doc([n("x", "9"), n("z", "0")]), {});

		const latest = seen.at(-1);
		expect(latest?.root.children?.map((c) => c.id)).toEqual(["x", "z"]);
		expect(
			(latest?.root.children ?? []).map((c) => (c.props as { t: string }).t),
		).toEqual(["9", "0"]);

		a.destroy();
		b.destroy();
	});
});
