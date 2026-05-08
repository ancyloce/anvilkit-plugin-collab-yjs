/**
 * D1 — native Y.Map IR tree opt-in. Two replicas paired bidirectionally
 * concurrently edit *different* nodes; both edits should survive when
 * `useNativeTree: true` is set on both adapters. Under the legacy
 * whole-document JSON LWW one of the edits would be overwritten.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import {
	applyUpdate,
	Doc as YDoc,
	encodeStateAsUpdate,
} from "yjs";

import { readNativeTree } from "../native-tree.js";
import { createYjsAdapter } from "../yjs-adapter.js";

function pair(a: YDoc, b: YDoc): void {
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(b, update, "replicate");
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(a, update, "replicate");
	});
}

function withTwoNodes(
	heroProps: Readonly<Record<string, unknown>>,
	buttonProps: Readonly<Record<string, unknown>>,
): PageIR {
	const ir = createFakePageIR();
	const children: PageIRNode[] = [
		{ id: "hero-1", type: "Hero", props: heroProps },
		{ id: "button-1", type: "Button", props: buttonProps },
	];
	return { ...ir, root: { ...ir.root, children } };
}

function findChild(ir: PageIR, id: string): PageIRNode | undefined {
	return ir.root.children?.find((c) => c.id === id);
}

const TREE_MAP = "anvilkit-collab:tree";

describe("createYjsAdapter useNativeTree", () => {
	it("preserves disjoint concurrent edits to different nodes (true CRDT race)", () => {
		const docA = new YDoc();
		const docB = new YDoc();

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

		// Seed BOTH replicas with the same initial IR before pairing.
		const initial = withTwoNodes(
			{ headline: "Initial Hero" },
			{ label: "Initial Button" },
		);
		adapterA.save(initial, {});
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");

		// Concurrent edits BEFORE pairing — neither replica has seen
		// the other's update when each constructs its save IR. This is
		// the canonical CRDT concurrency scenario.
		adapterA.save(
			withTwoNodes(
				{ headline: "Alice's Hero" },
				{ label: "Initial Button" },
			),
			{},
		);
		adapterB.save(
			withTwoNodes(
				{ headline: "Initial Hero" },
				{ label: "Bob's Button" },
			),
			{},
		);

		// NOW pair the replicas — each one's update lands on the other's tree.
		pair(docA, docB);
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");
		applyUpdate(docA, encodeStateAsUpdate(docB), "replicate");

		const liveA = readNativeTree(docA.getMap<unknown>(TREE_MAP));
		const liveB = readNativeTree(docB.getMap<unknown>(TREE_MAP));

		expect(liveA).toBeDefined();
		expect(liveB).toBeDefined();
		expect(liveA).toEqual(liveB);
		expect(findChild(liveA as PageIR, "hero-1")?.props.headline).toBe(
			"Alice's Hero",
		);
		expect(findChild(liveA as PageIR, "button-1")?.props.label).toBe(
			"Bob's Button",
		);
	});

	it("round-trips a full PageIR through the native tree", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, useNativeTree: true });
		const ir = withTwoNodes(
			{ headline: "Hello", count: 3, nested: { foo: "bar" } },
			{ label: "Click me" },
		);
		const id = adapter.save(ir, {});
		const loaded = adapter.load(id);
		// Snapshots use the legacy JSON encoding; this confirms the
		// fallback path remains intact when native tree is enabled.
		expect(findChild(loaded, "hero-1")?.props).toEqual(
			ir.root.children?.[0]?.props,
		);
		expect(findChild(loaded, "button-1")?.props).toEqual(
			ir.root.children?.[1]?.props,
		);

		// And the live native tree is consistent with the IR.
		const live = readNativeTree(doc.getMap<unknown>(TREE_MAP));
		expect(findChild(live as PageIR, "hero-1")?.props).toEqual(
			ir.root.children?.[0]?.props,
		);
	});

	it("legacy JSON-blob mode (default) does NOT preserve disjoint concurrent edits", () => {
		const docA = new YDoc();
		const docB = new YDoc();

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const initial = withTwoNodes(
			{ headline: "Initial Hero" },
			{ label: "Initial Button" },
		);
		adapterA.save(initial, {});
		applyUpdate(docB, encodeStateAsUpdate(docA), "replicate");
		pair(docA, docB);

		adapterA.save(
			withTwoNodes(
				{ headline: "Alice's Hero" },
				{ label: "Initial Button" },
			),
			{},
		);
		adapterB.save(
			withTwoNodes(
				{ headline: "Initial Hero" },
				{ label: "Bob's Button" },
			),
			{},
		);

		// Under whole-doc LWW, exactly one of the two edits wins. The
		// converged state still equals on both replicas.
		const liveASnapshotId = adapterA.list().at(-1)?.id;
		const liveBSnapshotId = adapterB.list().at(-1)?.id;
		expect(liveASnapshotId).toBeDefined();
		expect(liveBSnapshotId).toBeDefined();

		// Pull the converged "live IR" via the legacy pageIR key.
		const liveAJson = docA.getMap<string>("anvilkit-collab").get("pageIR");
		const liveBJson = docB.getMap<string>("anvilkit-collab").get("pageIR");
		expect(liveAJson).toBe(liveBJson);
		const merged = JSON.parse(liveAJson as string) as PageIR;
		const heroOk =
			findChild(merged, "hero-1")?.props.headline === "Alice's Hero";
		const buttonOk =
			findChild(merged, "button-1")?.props.label === "Bob's Button";
		// Pin the alpha-cycle behavior: at least ONE of the disjoint
		// edits lost. This is exactly what D1 (useNativeTree) fixes.
		expect(heroOk && buttonOk).toBe(false);
	});
});
