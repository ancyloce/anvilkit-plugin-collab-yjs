/**
 * @file L1 — native-tree is the default encoding. Verifies that
 * adapters constructed on a Y.Doc which only has the legacy
 * `pageIR` JSON-blob payload migrate to the native tree at
 * construction time (one-shot, transactional, idempotent).
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import { encodeIR } from "../encode.js";
import { DEFAULT_MAP_NAME, PAGE_IR_KEY } from "../keys.js";
import { NATIVE_VERSION_KEY, readNativeTree } from "../native-tree.js";
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

describe("native-tree migration (L1)", () => {
	it("defaults to native-tree (treeRoot is populated after the first save)", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, peer: { id: "alice" } });
		adapter.save(withHero("v1"), {});

		const treeRoot = doc.getMap<unknown>(`${DEFAULT_MAP_NAME}:tree`);
		expect(treeRoot.get(NATIVE_VERSION_KEY)).toBe("1");
		const decoded = readNativeTree(treeRoot);
		expect(decoded?.root.children?.[0]?.props.headline).toBe("v1");
	});

	it("hydrates the native tree from a legacy JSON-blob doc at construction time", () => {
		const doc = new YDoc();
		// Seed the doc with ONLY the legacy JSON-blob payload — no
		// native-tree state yet. This is the cross-version scenario
		// where a host upgrades from the JSON-blob encoding and rejoins
		// an existing room.
		const ir = withHero("legacy");
		doc.getMap<string>(DEFAULT_MAP_NAME).set(PAGE_IR_KEY, encodeIR(ir));

		// A pre-migration tree-root must be empty.
		const treeRoot = doc.getMap<unknown>(`${DEFAULT_MAP_NAME}:tree`);
		expect(treeRoot.has(NATIVE_VERSION_KEY)).toBe(false);

		// Constructing an adapter migrates the legacy blob into the
		// native tree in a single transaction.
		createYjsAdapter({ doc, peer: { id: "alice" } });

		expect(treeRoot.get(NATIVE_VERSION_KEY)).toBe("1");
		const restored = readNativeTree(treeRoot);
		expect(restored?.root.children?.[0]?.props.headline).toBe("legacy");
	});

	it("is idempotent across multiple adapter constructions on the same doc", () => {
		const doc = new YDoc();
		doc
			.getMap<string>(DEFAULT_MAP_NAME)
			.set(PAGE_IR_KEY, encodeIR(withHero("legacy")));

		const a1 = createYjsAdapter({ doc, peer: { id: "alice" } });
		const treeRoot = doc.getMap<unknown>(`${DEFAULT_MAP_NAME}:tree`);
		const firstSnapshot = readNativeTree(treeRoot);

		// Second adapter constructed on the same doc — must not
		// overwrite or duplicate the tree state.
		createYjsAdapter({ doc, peer: { id: "bob" } });
		const secondSnapshot = readNativeTree(treeRoot);

		expect(firstSnapshot).toEqual(secondSnapshot);
		a1.destroy();
	});

	it("leaves the tree empty if the legacy blob is corrupted", () => {
		const doc = new YDoc();
		doc.getMap<string>(DEFAULT_MAP_NAME).set(PAGE_IR_KEY, "{ not json");

		createYjsAdapter({ doc, peer: { id: "alice" } });
		const treeRoot = doc.getMap<unknown>(`${DEFAULT_MAP_NAME}:tree`);
		// Migration silently failed → tree is unset, ready for the next
		// authoritative save() to seed it.
		expect(treeRoot.has(NATIVE_VERSION_KEY)).toBe(false);
	});

	it("opt-out via `useNativeTree: false` skips the migration", () => {
		const doc = new YDoc();
		doc
			.getMap<string>(DEFAULT_MAP_NAME)
			.set(PAGE_IR_KEY, encodeIR(withHero("legacy")));

		createYjsAdapter({
			doc,
			peer: { id: "alice" },
			useNativeTree: false,
		});

		const treeRoot = doc.getMap<unknown>(`${DEFAULT_MAP_NAME}:tree`);
		expect(treeRoot.has(NATIVE_VERSION_KEY)).toBe(false);
	});
});
