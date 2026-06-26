/**
 * Report 0006 §4.1.2 — shared-type support contract. The plugin is a
 * PageIR-only Yjs adapter: it mirrors `PageIR` into a flat-addressed
 * `Y.Map` tree (one `Y.Map` per node) with a per-parent
 * `Y.Array<string>` `childIds` list and JSON-encoded prop values. It
 * does NOT bind native `Y.Text`, `Y.XmlElement`, `Y.XmlFragment`, or
 * subdocuments through its public surface.
 *
 * This pins that boundary as a machine-checkable PUBLIC contract so a
 * future change that silently widens (or breaks) the supported set has
 * to update the descriptor too, and proves the `getHostSharedRoot`
 * escape hatch is genuinely adapter-ignored.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Doc as YDoc } from "yjs";

import {
	getHostSharedRoot,
	isManagedSharedType,
	SHARED_TYPE_SUPPORT,
} from "../index.js";
import { readNativeTree } from "../utils/native-tree.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

describe("SHARED_TYPE_SUPPORT contract", () => {
	it("is exported from the public barrel and declares the PageIR-only model", () => {
		expect(SHARED_TYPE_SUPPORT).toBeDefined();
		expect(SHARED_TYPE_SUPPORT.model).toBe("page-ir");
		expect(SHARED_TYPE_SUPPORT.propEncoding).toBe("json-string");
	});

	it("manages exactly the structural containers the native tree uses", () => {
		// native-tree.ts stores nodes/props as `Y.Map` and `childIds` as
		// `Y.Array` — and nothing else.
		expect([...SHARED_TYPE_SUPPORT.managed].sort()).toEqual(
			["Y.Array", "Y.Map"].sort(),
		);
	});

	it("declares native text/xml/subdoc types as out of scope", () => {
		for (const name of [
			"Y.Text",
			"Y.XmlElement",
			"Y.XmlFragment",
			"Y.Doc",
		] as const) {
			expect(SHARED_TYPE_SUPPORT.unsupported).toContain(name);
		}
	});

	it("never lists a type as both managed and unsupported", () => {
		for (const name of SHARED_TYPE_SUPPORT.managed) {
			expect(SHARED_TYPE_SUPPORT.unsupported).not.toContain(name);
		}
	});
});

describe("isManagedSharedType", () => {
	it("is true only for the managed structural containers", () => {
		expect(isManagedSharedType("Y.Map")).toBe(true);
		expect(isManagedSharedType("Y.Array")).toBe(true);
	});

	it("is false for native types the adapter does not bind", () => {
		expect(isManagedSharedType("Y.Text")).toBe(false);
		expect(isManagedSharedType("Y.XmlElement")).toBe(false);
		expect(isManagedSharedType("Y.XmlFragment")).toBe(false);
		expect(isManagedSharedType("Y.Doc")).toBe(false);
	});
});

describe("getHostSharedRoot escape hatch", () => {
	function withHeadline(headline: string): PageIR {
		const ir = createFakePageIR();
		return {
			...ir,
			root: {
				...ir.root,
				children: [{ id: "hero-1", type: "Hero", props: { headline } }],
			},
		};
	}

	it("returns a host-owned Y.Map disjoint from the adapter roots", () => {
		const doc = new YDoc();
		const hostRoot = getHostSharedRoot(doc, "comments");
		expect(hostRoot).toBeInstanceOf(Y.Map);
		// Distinct top-level types from the adapter's legacy + tree roots.
		expect(hostRoot).not.toBe(doc.getMap("anvilkit-collab"));
		expect(hostRoot).not.toBe(doc.getMap("anvilkit-collab:tree"));
		// Same namespace ⇒ same handle (stable, idempotent).
		expect(getHostSharedRoot(doc, "comments")).toBe(hostRoot);
	});

	it("derives off the adapter mapName but never collides with its tree root", () => {
		const doc = new YDoc();
		const root = getHostSharedRoot(doc, "x", "room-7");
		expect(root).not.toBe(doc.getMap("room-7"));
		expect(root).not.toBe(doc.getMap("room-7:tree"));
	});

	it("is genuinely ignored by the adapter — host Y.Text does not leak into PageIR", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, peer: { id: "alice" } });

		// A host attaches a native Y.Text under its own root — exactly the
		// shared-type the descriptor says is out of scope.
		const hostRoot = getHostSharedRoot(doc, "comments");
		const text = new Y.Text();
		hostRoot.set("thread", text);
		text.insert(0, "an out-of-scope collaborative comment");

		adapter.save(withHeadline("Hello"), { label: "first" });

		const treeRoot = doc.getMap<unknown>("anvilkit-collab:tree");
		const decoded = readNativeTree(treeRoot);
		expect(decoded).toBeDefined();
		const hero = decoded?.root.children?.find((c) => c.id === "hero-1");
		expect(hero?.props.headline).toBe("Hello");

		// The native tree carries no trace of the host Y.Text, and the host
		// root still holds it untouched by the adapter.
		const treeKeys = [...treeRoot.keys()];
		expect(treeKeys).not.toContain("thread");
		expect(hostRoot.get("thread")).toBe(text);
		expect(text.toString()).toBe("an out-of-scope collaborative comment");

		adapter.destroy();
	});
});
