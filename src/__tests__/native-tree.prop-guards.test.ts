/**
 * Y3/§4.1.3 — bounded untrusted prop payload parsing.
 *
 * Prop VALUES are peer-authored JSON strings round-tripped through
 * `JSON.parse` in `parseNodeOwn`. A hostile / buggy peer can write a
 * single prop value that is pathologically large, deeply nested, or an
 * over-long array. These tests inject such payloads directly into a
 * node's `props` Y.Map (exactly what a malicious peer's replicated
 * update materializes to) and assert the decode boundary DROPS the
 * offending prop, surfaces the matching guard reason, keeps the rest of
 * the node/tree intact, and still round-trips legitimate content under
 * the permissive defaults.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Doc as YDoc } from "yjs";

import { nativeNodeKey } from "../utils/keys.js";
import {
	applyIRToNativeTree,
	type ReadGuardTrip,
	readNativeTree,
	readNodeShallow,
} from "../utils/native-tree.js";

const TARGET_ID = "hero-1";

function setup(): { doc: YDoc; treeRoot: Y.Map<unknown>; ir: PageIR } {
	const doc = new YDoc();
	const treeRoot = doc.getMap<unknown>("tree");
	const ir = createFakePageIR();
	doc.transact(() => {
		applyIRToNativeTree(treeRoot, ir, undefined);
	});
	return { doc, treeRoot, ir };
}

/** Write an already-encoded JSON string straight into a node's prop map. */
function injectRawProp(
	treeRoot: Y.Map<unknown>,
	nodeId: string,
	key: string,
	encoded: string,
): void {
	const nodeMap = treeRoot.get(nativeNodeKey(nodeId)) as Y.Map<unknown>;
	const propsMap = nodeMap.get("props") as Y.Map<unknown>;
	propsMap.set(key, encoded);
}

/** Encode then inject a structured value as a node prop. */
function injectProp(
	treeRoot: Y.Map<unknown>,
	nodeId: string,
	key: string,
	value: unknown,
): void {
	injectRawProp(treeRoot, nodeId, key, JSON.stringify(value));
}

function nestArray(depth: number): unknown {
	let v: unknown = 0;
	for (let i = 0; i < depth; i += 1) v = [v];
	return v;
}

function heroProps(
	ir: PageIR | undefined,
): Record<string, unknown> | undefined {
	const node = ir?.root.children?.find((c) => c.id === TARGET_ID);
	return node?.props as Record<string, unknown> | undefined;
}

describe("Y3 — bounded prop payload decode (native tree)", () => {
	it("drops an over-byte prop value (measured PRE-parse) and records `prop-bytes`", () => {
		const { treeRoot } = setup();
		// A perfectly *parseable* 1000-char string — only the byte bound
		// rejects it, proving the limit is enforced before JSON.parse and
		// not merely as a parse-failure side effect.
		injectProp(treeRoot, TARGET_ID, "evil", "x".repeat(1000));
		const onGuardTrip = vi.fn<(reason: ReadGuardTrip) => void>();
		const ir = readNativeTree(treeRoot, {
			onGuardTrip,
			propGuards: { maxBytes: 100 },
		});
		const props = heroProps(ir);
		expect(props).toBeDefined();
		// Offending prop dropped, legit sibling prop preserved.
		expect(props?.evil).toBeUndefined();
		expect(props?.headline).toBe("Hello");
		expect(onGuardTrip).toHaveBeenCalledWith("prop-bytes");
	});

	it("drops an over-deep prop value and records `prop-depth`", () => {
		const { treeRoot } = setup();
		injectProp(treeRoot, TARGET_ID, "evil", nestArray(12));
		const onGuardTrip = vi.fn<(reason: ReadGuardTrip) => void>();
		const ir = readNativeTree(treeRoot, {
			onGuardTrip,
			propGuards: { maxDepth: 5 },
		});
		const props = heroProps(ir);
		expect(props?.evil).toBeUndefined();
		expect(props?.headline).toBe("Hello");
		expect(onGuardTrip).toHaveBeenCalledWith("prop-depth");
	});

	it("drops an over-long array prop value and records `prop-array`", () => {
		const { treeRoot } = setup();
		injectProp(treeRoot, TARGET_ID, "evil", new Array(20).fill(0));
		const onGuardTrip = vi.fn<(reason: ReadGuardTrip) => void>();
		const ir = readNativeTree(treeRoot, {
			onGuardTrip,
			propGuards: { maxArrayLength: 5 },
		});
		const props = heroProps(ir);
		expect(props?.evil).toBeUndefined();
		expect(props?.headline).toBe("Hello");
		expect(onGuardTrip).toHaveBeenCalledWith("prop-array");
	});

	it("drops an over-large (node-count) prop value and records `prop-nodes`", () => {
		const { treeRoot } = setup();
		const fat: Record<string, number> = {};
		for (let i = 0; i < 20; i += 1) fat[`k${i}`] = i;
		injectProp(treeRoot, TARGET_ID, "evil", fat);
		const onGuardTrip = vi.fn<(reason: ReadGuardTrip) => void>();
		const ir = readNativeTree(treeRoot, {
			onGuardTrip,
			propGuards: { maxNodes: 5 },
		});
		const props = heroProps(ir);
		expect(props?.evil).toBeUndefined();
		expect(props?.headline).toBe("Hello");
		expect(onGuardTrip).toHaveBeenCalledWith("prop-nodes");
	});

	it("a single hostile prop does NOT blank the rest of the tree", () => {
		const { treeRoot } = setup();
		injectProp(treeRoot, TARGET_ID, "evil", "x".repeat(1000));
		const ir = readNativeTree(treeRoot, { propGuards: { maxBytes: 100 } });
		// Root + hero node still decode; only the bad prop is gone.
		expect(ir?.root.id).toBe("root");
		expect(ir?.root.children?.[0]?.id).toBe(TARGET_ID);
		expect(heroProps(ir)?.headline).toBe("Hello");
	});

	it("readNodeShallow honors the prop guards too (live-IR path)", () => {
		const { treeRoot } = setup();
		injectProp(treeRoot, TARGET_ID, "evil", nestArray(12));
		const onGuardTrip = vi.fn<(reason: ReadGuardTrip) => void>();
		const shallow = readNodeShallow(treeRoot, TARGET_ID, {
			onGuardTrip,
			propGuards: { maxDepth: 5 },
		});
		expect(shallow).toBeDefined();
		const props = shallow?.node.props as Record<string, unknown> | undefined;
		expect(props?.evil).toBeUndefined();
		expect(props?.headline).toBe("Hello");
		expect(onGuardTrip).toHaveBeenCalledWith("prop-depth");
	});

	it("legitimate props round-trip unchanged under the permissive defaults", () => {
		const { treeRoot } = setup();
		const legit = {
			headline: "Hello",
			items: Array.from({ length: 50 }, (_, i) => ({ id: i, label: `i${i}` })),
			nested: { a: { b: { c: { d: 1 } } } },
			flag: true,
			count: 42,
		};
		injectProp(treeRoot, TARGET_ID, "data", legit);
		const onGuardTrip = vi.fn<(reason: ReadGuardTrip) => void>();
		// No propGuards override — defaults must admit ordinary PageIR.
		const ir = readNativeTree(treeRoot, { onGuardTrip });
		expect(heroProps(ir)?.data).toEqual(legit);
		expect(heroProps(ir)?.headline).toBe("Hello");
		expect(onGuardTrip).not.toHaveBeenCalled();
	});
});
