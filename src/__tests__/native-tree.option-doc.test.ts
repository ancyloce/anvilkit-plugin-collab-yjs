/**
 * @file Report 0006 §4.3.3 — the `useNativeTree` option contract must
 * document the AUTOMATIC, one-way legacy→native migration that happens
 * when the native tree is empty but a legacy `pageIR` JSON blob exists.
 *
 * Two anchors:
 *   (a) Source-contract — the TSDoc block on `useNativeTree` actually
 *       mentions the migration-when-empty constraint.
 *   (b) Behavior — the documented migration truly fires on first load and
 *       does NOT clobber a non-empty native tree.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import { encodeIR } from "../utils/encode.js";
import { DEFAULT_MAP_NAME, PAGE_IR_KEY } from "../utils/keys.js";
import {
	applyIRToNativeTree,
	NATIVE_VERSION_KEY,
	readNativeTree,
} from "../utils/native-tree.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

const TYPES_PATH = fileURLToPath(new URL("../types/types.ts", import.meta.url));

/**
 * Extract the `/** ... *\/` TSDoc block that immediately precedes the
 * `readonly useNativeTree?: boolean;` declaration in types.ts.
 */
function extractUseNativeTreeDoc(source: string): string {
	const declIndex = source.indexOf("readonly useNativeTree?: boolean;");
	expect(declIndex).toBeGreaterThan(-1);
	const before = source.slice(0, declIndex);
	const openIndex = before.lastIndexOf("/**");
	const closeIndex = before.lastIndexOf("*/");
	expect(openIndex).toBeGreaterThan(-1);
	expect(closeIndex).toBeGreaterThan(openIndex);
	// The closing `*/` must be the one that terminates the doc block
	// directly above the declaration (no other comment in between).
	return before.slice(openIndex, closeIndex + 2);
}

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

describe("useNativeTree option contract (Report 0006 §4.3.3)", () => {
	it("(a) documents the automatic legacy→native migration-when-empty constraint", () => {
		const source = readFileSync(TYPES_PATH, "utf8");
		const doc = extractUseNativeTreeDoc(source);

		// The doc must surface the AUTOMATIC migration of a legacy blob
		// into the native tree when the native tree is EMPTY on first load.
		expect(doc).toMatch(/migrat/i);
		expect(doc).toMatch(/empty/i);
		// And it must keep reinforcing the existing "cannot share a Y.Doc"
		// single-mode-per-room constraint.
		expect(doc).toMatch(/Y\.Doc/);
	});

	it("(b) behavior: migrates a legacy pageIR blob into the empty native tree on first load", () => {
		const ydoc = new YDoc();
		// Seed ONLY the legacy JSON-blob payload; the native tree is empty.
		ydoc
			.getMap<string>(DEFAULT_MAP_NAME)
			.set(PAGE_IR_KEY, encodeIR(withHero("legacy")));

		const treeRoot = ydoc.getMap<unknown>(`${DEFAULT_MAP_NAME}:tree`);
		expect(treeRoot.has(NATIVE_VERSION_KEY)).toBe(false);

		// Constructing the adapter with the (default) native tree triggers
		// the documented automatic migration.
		createYjsAdapter({ doc: ydoc, peer: { id: "alice" }, useNativeTree: true });

		expect(treeRoot.get(NATIVE_VERSION_KEY)).toBe("1");
		const restored = readNativeTree(treeRoot);
		expect(restored?.root.children?.[0]?.props.headline).toBe("legacy");
	});

	it("(b) behavior: does NOT clobber a non-empty native tree (one-way, idempotent)", () => {
		const ydoc = new YDoc();
		// Pre-populate the native tree with one IR...
		const treeRoot = ydoc.getMap<unknown>(`${DEFAULT_MAP_NAME}:tree`);
		ydoc.transact(() => {
			applyIRToNativeTree(treeRoot, withHero("native-existing"), undefined);
		});
		expect(treeRoot.get(NATIVE_VERSION_KEY)).toBe("1");

		// ...AND seed a different legacy blob. The non-empty native tree must
		// short-circuit the migration so the blob never overwrites it.
		ydoc
			.getMap<string>(DEFAULT_MAP_NAME)
			.set(PAGE_IR_KEY, encodeIR(withHero("legacy-blob")));

		createYjsAdapter({ doc: ydoc, peer: { id: "alice" }, useNativeTree: true });

		const restored = readNativeTree(treeRoot);
		expect(restored?.root.children?.[0]?.props.headline).toBe(
			"native-existing",
		);
	});
});
