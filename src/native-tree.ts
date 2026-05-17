import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import * as Y from "yjs";

import {
	NATIVE_ASSETS_KEY,
	NATIVE_METADATA_KEY,
	NATIVE_NODE_PREFIX,
	NATIVE_ROOT_ID_KEY,
	NATIVE_VERSION_KEY,
	nativeNodeKey,
} from "./keys.js";

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

// Re-export the native-tree keys for backward compatibility with
// callers that imported them from this module (e.g. test files).
// The canonical home is `./keys.ts` (M8).
export {
	NATIVE_ASSETS_KEY,
	NATIVE_METADATA_KEY,
	NATIVE_NODE_PREFIX,
	NATIVE_ROOT_ID_KEY,
	NATIVE_VERSION_KEY,
} from "./keys.js";

interface NodeYMap extends Y.Map<unknown> {}

/**
 * Reason a guarded native-tree read bailed out early. Shared Yjs data
 * is remote-origin and can be malformed or malicious (M4): cycles,
 * repeated child ids, pathologically deep chains, or an excessive node
 * count would otherwise recurse until the call stack overflows.
 */
export type ReadGuardTrip = "cycle" | "max-depth" | "max-nodes";

export interface ReadGuardOptions {
	/** Maximum tree depth before bailing. Default 5000. */
	readonly maxDepth?: number;
	/** Maximum total node count before bailing. Default 200000. */
	readonly maxNodes?: number;
	/**
	 * Invoked once per read the first time any guard trips. Hosts wire
	 * this to `metrics.setDegraded(true)` so a truncated decode surfaces
	 * instead of silently dropping nodes.
	 */
	readonly onGuardTrip?: (reason: ReadGuardTrip) => void;
}

const DEFAULT_MAX_DEPTH = 5000;
const DEFAULT_MAX_NODES = 200000;

interface ReadGuard {
	readonly visited: Set<string>;
	count: number;
	readonly maxDepth: number;
	readonly maxNodes: number;
	tripped: boolean;
	readonly onGuardTrip?: (reason: ReadGuardTrip) => void;
}

function createReadGuard(options?: ReadGuardOptions): ReadGuard {
	return {
		visited: new Set<string>(),
		count: 0,
		maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxNodes: options?.maxNodes ?? DEFAULT_MAX_NODES,
		tripped: false,
		onGuardTrip: options?.onGuardTrip,
	};
}

function trip(guard: ReadGuard, reason: ReadGuardTrip): void {
	if (!guard.tripped) {
		guard.tripped = true;
		guard.onGuardTrip?.(reason);
	}
}

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
		const key = nativeNodeKey(node.id);
		let nodeMap = root.get(key) as NodeYMap | undefined;
		if (!(nodeMap instanceof Y.Map)) {
			nodeMap = new Y.Map<unknown>();
			root.set(key, nodeMap);
		}
		writeNode(nodeMap, node, baselineNodes.get(node.id));
	});

	const baselineIds = new Set(baselineNodes.keys());
	for (const id of baselineIds) {
		if (!desiredIds.has(id)) root.delete(nativeNodeKey(id));
	}
}

export function readNativeTree(
	root: Y.Map<unknown>,
	options?: ReadGuardOptions,
): PageIR | undefined {
	const version = root.get(NATIVE_VERSION_KEY);
	const rootId = root.get(NATIVE_ROOT_ID_KEY);
	if (version !== "1" || typeof rootId !== "string") return undefined;
	const guard = createReadGuard(options);
	const rootNode = readNode(root, rootId, guard, 0);
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

/**
 * Map a batch of `Y.Map.observeDeep` events into the set of node ids
 * whose subtree changed, plus a `structural` flag that forces the
 * incremental live-IR cache to fall back to a full rebuild (H3).
 *
 * `structural` is set when the change cannot be applied as a pure
 * node-local prop patch: a `version`/`rootId` change, an `assets`/
 * `metadata` change, a `node:<id>` map added/removed at the root, or
 * any `childIds` reorder/membership change (which moves nodes between
 * parents).
 */
export function deriveChangedNodeIds(
	events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
): {
	ids: Set<string>;
	structural: boolean;
} {
	const ids = new Set<string>();
	let structural = false;
	for (const event of events) {
		const path = event.path;
		if (path.length === 0) {
			// Event on the tree root map itself.
			for (const key of event.changes.keys.keys()) {
				if (
					key === NATIVE_VERSION_KEY ||
					key === NATIVE_ROOT_ID_KEY ||
					key === NATIVE_ASSETS_KEY ||
					key === NATIVE_METADATA_KEY
				) {
					structural = true;
				} else if (key.startsWith(NATIVE_NODE_PREFIX)) {
					// A whole node Y.Map was added or removed.
					structural = true;
					ids.add(key.slice(NATIVE_NODE_PREFIX.length));
				}
			}
			continue;
		}
		const first = path[0];
		if (typeof first !== "string" || !first.startsWith(NATIVE_NODE_PREFIX)) {
			continue;
		}
		ids.add(first.slice(NATIVE_NODE_PREFIX.length));
		// A childIds reorder/membership change relinks the tree, so a
		// node-local patch is insufficient — force a full rebuild.
		if (path.includes("childIds")) structural = true;
	}
	return { ids, structural };
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
	// Pre-compute baseline encodings once per call so each prop is
	// JSON.stringify'd at most twice across this reconciliation
	// (once for the live value, once for the baseline), not 2× per
	// prop per save like the previous tight-loop implementation (M6).
	const baseEncoded = new Map<string, string>();
	for (const key of Object.keys(base)) {
		baseEncoded.set(key, JSON.stringify(base[key]));
	}
	for (const [key, value] of Object.entries(props)) {
		const encoded = JSON.stringify(value);
		const prevEncoded = baseEncoded.get(key);
		// Only write keys whose value actually changed in the LOCAL
		// authoring session; otherwise leave whatever the CRDT layer
		// holds so concurrent disjoint edits both survive.
		if (encoded !== prevEncoded) target.set(key, encoded);
	}
	for (const key of baseEncoded.keys()) {
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

/**
 * Reconstruct a single node and its subtree from the flat native tree,
 * guarded against cycles/depth/node-count. Exported so the incremental
 * live-IR cache (`live-ir.ts`) can re-read only changed subtrees instead
 * of rebuilding the whole document on every remote event (H3).
 */
export function readSubtree(
	root: Y.Map<unknown>,
	id: string,
	options?: ReadGuardOptions,
): PageIRNode | undefined {
	return readNode(root, id, createReadGuard(options), 0);
}

function readNode(
	root: Y.Map<unknown>,
	id: string,
	guard: ReadGuard,
	depth: number,
): PageIRNode | undefined {
	if (guard.tripped) return undefined;
	if (depth > guard.maxDepth) {
		trip(guard, "max-depth");
		return undefined;
	}
	if (guard.visited.has(id)) {
		// Repeated id across the traversal == cycle or duplicated child
		// (the IR contract is a tree, not a DAG). Stop expanding rather
		// than recurse forever.
		trip(guard, "cycle");
		return undefined;
	}
	guard.count += 1;
	if (guard.count > guard.maxNodes) {
		trip(guard, "max-nodes");
		return undefined;
	}
	guard.visited.add(id);
	const own = parseNodeOwn(root, id);
	if (!own) return undefined;
	const { node, childIds } = own;
	const children: PageIRNode[] = [];
	for (const childId of childIds) {
		const child = readNode(root, childId, guard, depth + 1);
		if (child) children.push(child);
	}
	if (children.length > 0) node.children = children;
	return node as unknown as PageIRNode;
}

/**
 * A node's own scalar/prop fields plus the raw ordered child id list,
 * WITHOUT recursing into children. The incremental live-IR cache
 * (`live-ir.ts`, H3) re-reads only the changed nodes through this and
 * relinks the tree itself, so an unchanged node's props are never
 * re-`JSON.parse`d on a remote event.
 */
export interface ShallowNativeNode {
	/** Node minus `children` — assignable into a `PageIRNode`. */
	readonly node: Record<string, unknown>;
	readonly childIds: readonly string[];
}

/** Parse one node's own fields + child id list (no recursion). */
export function readNodeShallow(
	root: Y.Map<unknown>,
	id: string,
): ShallowNativeNode | undefined {
	return parseNodeOwn(root, id);
}

function parseNodeOwn(
	root: Y.Map<unknown>,
	id: string,
): { node: Record<string, unknown>; childIds: string[] } | undefined {
	const map = root.get(nativeNodeKey(id));
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
	const childIdsRaw = map.get("childIds");
	const childIds: string[] = [];
	if (childIdsRaw instanceof Y.Array) {
		for (const childId of childIdsRaw.toArray()) {
			if (typeof childId === "string") childIds.push(childId);
		}
	}
	const slot = map.get("slot");
	const slotKind = map.get("slotKind");
	const rawAssets = map.get("assets");
	const rawMeta = map.get("meta");

	const node: Record<string, unknown> = { id, type, props };
	if (typeof slot === "string") node.slot = slot;
	if (typeof slotKind === "string") node.slotKind = slotKind;
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
	return { node, childIds };
}

function walkNodes(root: PageIRNode, visit: (node: PageIRNode) => void): void {
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

function parseJSONOr<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== "string") return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}
