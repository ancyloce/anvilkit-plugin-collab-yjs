import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import * as Y from "yjs";

/**
 * Flat-addressed native Y tree for `PageIR` — Phase 1 (D1) opt-in.
 *
 * A single host-supplied root `Y.Map` holds:
 *
 *   "version"  primitive string
 *   "rootId"   primitive string (id of the root PageIRNode)
 *   "assets"   primitive string (JSON-encoded PageIR.assets — opaque
 *              for alpha)
 *   "metadata" primitive string (JSON-encoded PageIR.metadata — opaque
 *              for alpha)
 *   "node:<id>" Y.Map per node (flat addressing)
 *
 * Each per-node Y.Map carries:
 *
 *   "id"       primitive string (== <id>)
 *   "type"     primitive string
 *   "slot"     optional primitive string
 *   "slotKind" optional primitive string
 *   "props"    Y.Map<unknown>; each key holds JSON-encoded prop value
 *              (props are opaque to the IR contract).
 *   "childIds" Y.Array<string> — ordered ids of child nodes
 *   "assets"   optional primitive string (JSON-encoded PageIRNode.assets)
 *   "meta"     optional primitive string (JSON-encoded PageIRNode.meta)
 *
 * The flat addressing means two peers concurrently editing **different**
 * node ids touch disjoint Y.Maps and merge cleanly. Two peers editing
 * the same node still rely on Y.Map prop-level LWW.
 */

export const NATIVE_VERSION_KEY = "version";
export const NATIVE_ROOT_ID_KEY = "rootId";
export const NATIVE_ASSETS_KEY = "assets";
export const NATIVE_METADATA_KEY = "metadata";
export const NATIVE_NODE_PREFIX = "node:";

interface NodeYMap extends Y.Map<unknown> {}

export function applyIRToNativeTree(
	root: Y.Map<unknown>,
	ir: PageIR,
	baseline: PageIR | undefined,
): void {
	if (root.get(NATIVE_VERSION_KEY) !== ir.version) {
		root.set(NATIVE_VERSION_KEY, ir.version);
	}
	if (root.get(NATIVE_ROOT_ID_KEY) !== ir.root.id) {
		root.set(NATIVE_ROOT_ID_KEY, ir.root.id);
	}
	const newAssets = JSON.stringify(ir.assets ?? []);
	const baseAssets = JSON.stringify(baseline?.assets ?? []);
	if (newAssets !== baseAssets) root.set(NATIVE_ASSETS_KEY, newAssets);
	const newMeta = JSON.stringify(ir.metadata ?? {});
	const baseMeta = JSON.stringify(baseline?.metadata ?? {});
	if (newMeta !== baseMeta) root.set(NATIVE_METADATA_KEY, newMeta);

	const baselineNodes = new Map<string, PageIRNode>();
	if (baseline) walkNodes(baseline.root, (n) => baselineNodes.set(n.id, n));

	const desiredIds = new Set<string>();
	collectIds(ir.root, desiredIds);

	walkNodes(ir.root, (node) => {
		const key = nodeKey(node.id);
		let nodeMap = root.get(key) as NodeYMap | undefined;
		if (!(nodeMap instanceof Y.Map)) {
			nodeMap = new Y.Map<unknown>();
			root.set(key, nodeMap);
		}
		writeNode(nodeMap, node, baselineNodes.get(node.id));
	});

	const baselineIds = new Set(baselineNodes.keys());
	for (const id of baselineIds) {
		if (!desiredIds.has(id)) root.delete(nodeKey(id));
	}
}

export function readNativeTree(root: Y.Map<unknown>): PageIR | undefined {
	const version = root.get(NATIVE_VERSION_KEY);
	const rootId = root.get(NATIVE_ROOT_ID_KEY);
	if (version !== "1" || typeof rootId !== "string") return undefined;
	const rootNode = readNode(root, rootId);
	if (!rootNode) return undefined;
	const rawAssets = root.get(NATIVE_ASSETS_KEY);
	const rawMeta = root.get(NATIVE_METADATA_KEY);
	const assets = parseJSONOr(rawAssets, []);
	const metadata = parseJSONOr(rawMeta, {});
	return {
		version: "1",
		root: rootNode,
		assets,
		metadata,
	} as PageIR;
}

function writeNode(
	map: NodeYMap,
	node: PageIRNode,
	baseline: PageIRNode | undefined,
): void {
	if (map.get("id") !== node.id) map.set("id", node.id);
	if (map.get("type") !== node.type) map.set("type", node.type);
	writeOrClear(map, "slot", node.slot, baseline?.slot);
	writeOrClear(map, "slotKind", node.slotKind, baseline?.slotKind);

	let propsMap = map.get("props");
	if (!(propsMap instanceof Y.Map)) {
		propsMap = new Y.Map<unknown>();
		map.set("props", propsMap);
	}
	reconcileProps(propsMap as Y.Map<unknown>, node.props, baseline?.props);

	let childIds = map.get("childIds");
	if (!(childIds instanceof Y.Array)) {
		childIds = new Y.Array<string>();
		map.set("childIds", childIds);
	}
	reconcileChildIds(
		childIds as Y.Array<string>,
		node.children ?? [],
		baseline?.children ?? [],
	);

	const newAssets = node.assets ? JSON.stringify(node.assets) : undefined;
	const baseAssets = baseline?.assets
		? JSON.stringify(baseline.assets)
		: undefined;
	if (newAssets !== baseAssets) {
		if (newAssets !== undefined) map.set("assets", newAssets);
		else map.delete("assets");
	}
	const newMeta = node.meta ? JSON.stringify(node.meta) : undefined;
	const baseMeta = baseline?.meta ? JSON.stringify(baseline.meta) : undefined;
	if (newMeta !== baseMeta) {
		if (newMeta !== undefined) map.set("meta", newMeta);
		else map.delete("meta");
	}
}

function writeOrClear(
	map: NodeYMap,
	key: string,
	next: string | undefined,
	prev: string | undefined,
): void {
	if (next === prev) return;
	if (next === undefined) map.delete(key);
	else map.set(key, next);
}

function reconcileProps(
	target: Y.Map<unknown>,
	props: Readonly<Record<string, unknown>>,
	baseline: Readonly<Record<string, unknown>> | undefined,
): void {
	const base = baseline ?? {};
	for (const [key, value] of Object.entries(props)) {
		const encoded = JSON.stringify(value);
		const baseEncoded = key in base ? JSON.stringify(base[key]) : undefined;
		// Only write keys whose value actually changed in the LOCAL
		// authoring session; otherwise leave whatever the CRDT layer
		// holds so concurrent disjoint edits both survive.
		if (encoded !== baseEncoded) target.set(key, encoded);
	}
	for (const key of Object.keys(base)) {
		if (!(key in props)) target.delete(key);
	}
}

function reconcileChildIds(
	target: Y.Array<string>,
	children: readonly PageIRNode[],
	baseline: readonly PageIRNode[],
): void {
	const desired = children.map((c) => c.id);
	const baseIds = baseline.map((c) => c.id);
	if (sameList(desired, baseIds)) return;
	target.delete(0, target.length);
	if (desired.length > 0) target.insert(0, desired);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function readNode(
	root: Y.Map<unknown>,
	id: string,
): PageIRNode | undefined {
	const map = root.get(nodeKey(id));
	if (!(map instanceof Y.Map)) return undefined;
	const type = map.get("type");
	if (typeof type !== "string") return undefined;
	const propsMap = map.get("props");
	const props: Record<string, unknown> = {};
	if (propsMap instanceof Y.Map) {
		for (const [key, raw] of propsMap.entries()) {
			if (typeof raw !== "string") continue;
			try {
				props[key] = JSON.parse(raw);
			} catch {
				// drop malformed prop value
			}
		}
	}
	const childIds = map.get("childIds");
	const children: PageIRNode[] = [];
	if (childIds instanceof Y.Array) {
		for (const childId of childIds.toArray()) {
			if (typeof childId !== "string") continue;
			const child = readNode(root, childId);
			if (child) children.push(child);
		}
	}
	const slot = map.get("slot");
	const slotKind = map.get("slotKind");
	const rawAssets = map.get("assets");
	const rawMeta = map.get("meta");

	const node: Record<string, unknown> = {
		id,
		type,
		props,
	};
	if (typeof slot === "string") node.slot = slot;
	if (typeof slotKind === "string") node.slotKind = slotKind;
	if (children.length > 0) node.children = children;
	if (typeof rawAssets === "string") {
		const assets = parseJSONOr(rawAssets, undefined);
		if (Array.isArray(assets)) node.assets = assets;
	}
	if (typeof rawMeta === "string") {
		const meta = parseJSONOr(rawMeta, undefined);
		if (meta && typeof meta === "object" && !Array.isArray(meta)) {
			node.meta = meta;
		}
	}
	return node as unknown as PageIRNode;
}

function walkNodes(
	root: PageIRNode,
	visit: (node: PageIRNode) => void,
): void {
	const stack: PageIRNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		visit(node);
		if (node.children) stack.push(...node.children);
	}
}

function collectIds(node: PageIRNode, out: Set<string>): void {
	out.add(node.id);
	if (node.children) for (const child of node.children) collectIds(child, out);
}

function nodeKey(id: string): string {
	return `${NATIVE_NODE_PREFIX}${id}`;
}

function parseJSONOr<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== "string") return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}
