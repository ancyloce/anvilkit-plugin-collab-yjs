/**
 * Stage 4a / I1 §3.1 — incremental local save.
 *
 * `diffIRNodesForLocalSave` classifies `structural: true` ONLY for a
 * missing prior IR / root-id change (full `applyIRToNativeTree`).
 * Everything else — pure prop edits AND P1 relinks (node add/remove,
 * childIds reorder/membership) — is non-structural and carried in
 * `changed` + `removed`, applied O(changed) via
 * `applyChangedNodesToNativeTree`. The incremental path must be
 * byte-equivalent: a remote peer replicating the Y.Doc must read back
 * exactly the locally-saved IR after a mix of saves.
 */

import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import { hashNodeContent } from "../utils/encode.js";
import { diffIRNodesForLocalSave } from "../utils/native-tree.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

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

	it("P1 — adding a node is a non-structural relink (added node + parent in changed)", () => {
		const prev = doc([n("a", "0")]);
		const d = diffIRNodesForLocalSave(prev, doc([n("a", "0"), n("b", "0")]));
		expect(d.structural).toBe(false);
		// Parent relinked (childIds gained "b") + the new node itself.
		expect(new Set(d.changed.keys())).toEqual(new Set(["root", "b"]));
		expect(d.removed.size).toBe(0);
		// Added node has no baseline (written fresh, like the full apply).
		expect(d.baseline.has("b")).toBe(false);
	});

	it("P1 — removing a node is a non-structural relink (removed set + parent in changed)", () => {
		const prev = doc([n("a", "0"), n("b", "0")]);
		const d = diffIRNodesForLocalSave(prev, doc([n("a", "0")]));
		expect(d.structural).toBe(false);
		expect([...d.removed]).toEqual(["b"]);
		expect(d.changed.has("root")).toBe(true); // parent childIds shrank
	});

	it("P1 — reordering children is a non-structural relink (parent in changed)", () => {
		const prev = doc([n("a", "0"), n("b", "0")]);
		const next = doc([n("b", "0"), n("a", "0")]);
		const d = diffIRNodesForLocalSave(prev, next);
		expect(d.structural).toBe(false);
		expect(d.changed.has("root")).toBe(true);
		expect(d.removed.size).toBe(0);
		// Leaf nodes unchanged — only the parent's childIds reordered.
		expect(d.changed.has("a")).toBe(false);
		expect(d.changed.has("b")).toBe(false);
	});

	it("P2 — the prev-hash fast path classifies identically to the stringify path", () => {
		const prev = doc([
			{ id: "a", type: "Hero", props: { t: "0" } },
			{ id: "b", type: "Hero", props: { t: "0" } },
			{ id: "c", type: "Hero", props: { t: "0" } },
		]);
		// Edit b's props, change c's type, reorder, drop nothing.
		const next = doc([
			{ id: "a", type: "Hero", props: { t: "0" } },
			{ id: "c", type: "Banner", props: { t: "0" } },
			{ id: "b", type: "Hero", props: { t: "9" } },
		]);
		// Build the prev-side hash map exactly as the live-IR cache would.
		const prevHashes = new Map<string, string>();
		const walk = (n: PageIR["root"]): void => {
			prevHashes.set(n.id, hashNodeContent(n));
			for (const k of n.children ?? []) walk(k);
		};
		walk(prev.root);

		const slow = diffIRNodesForLocalSave(prev, next);
		const fast = diffIRNodesForLocalSave(prev, next, prevHashes);
		expect(new Set(fast.changed.keys())).toEqual(new Set(slow.changed.keys()));
		expect([...fast.removed]).toEqual([...slow.removed]);
		expect(fast.structural).toBe(slow.structural);
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
		// 3) P1 relink: remove a node (incremental, byte-equivalent)
		a.save(doc([n("x", "1"), n("z", "0")]), {});
		// 4) pure prop edit again after the relink
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
