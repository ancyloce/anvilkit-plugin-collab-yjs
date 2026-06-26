import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import * as Y from "yjs";

import type { PropGuardOptions } from "../types/types.js";
import { hashNodeContent } from "./encode.js";

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

// A4 — concentrate the unavoidable runtime `instanceof` casts on
// untrusted CRDT state into four accessors so per-node Y.Map/Y.Array
// shape assumptions live in exactly one place. Read accessors return
// `undefined` for a missing/ill-typed slot; the `getOrCreate*`
// accessors replace an ill-typed slot with a fresh empty container
// (the existing write-path behaviour, unchanged).

function getNodeMap(root: Y.Map<unknown>, id: string): NodeYMap | undefined {
	const m = root.get(nativeNodeKey(id));
	return m instanceof Y.Map ? (m as NodeYMap) : undefined;
}

function getOrCreateNodeMap(root: Y.Map<unknown>, key: string): NodeYMap {
	const existing = root.get(key);
	if (existing instanceof Y.Map) return existing as NodeYMap;
	const created = new Y.Map<unknown>();
	root.set(key, created);
	return created as NodeYMap;
}

function getPropsMap(nodeMap: Y.Map<unknown>): Y.Map<unknown> | undefined {
	const p = nodeMap.get("props");
	return p instanceof Y.Map ? (p as Y.Map<unknown>) : undefined;
}

function getOrCreatePropsMap(nodeMap: Y.Map<unknown>): Y.Map<unknown> {
	const existing = nodeMap.get("props");
	if (existing instanceof Y.Map) return existing as Y.Map<unknown>;
	const created = new Y.Map<unknown>();
	nodeMap.set("props", created);
	return created;
}

function getChildIds(nodeMap: Y.Map<unknown>): Y.Array<string> | undefined {
	const c = nodeMap.get("childIds");
	return c instanceof Y.Array ? (c as Y.Array<string>) : undefined;
}

function getOrCreateChildIds(nodeMap: Y.Map<unknown>): Y.Array<string> {
	const existing = nodeMap.get("childIds");
	if (existing instanceof Y.Array) return existing as Y.Array<string>;
	const created = new Y.Array<string>();
	nodeMap.set("childIds", created);
	return created;
}

/**
 * Reason a guarded native-tree read bailed out or dropped data. Shared
 * Yjs data is remote-origin and can be malformed or malicious (M4).
 *
 * Structural (FATAL — abort the remaining traversal): `cycle`,
 * `max-depth`, `max-nodes` — a repeated child id, a pathologically deep
 * chain, or an excessive node count that would otherwise recurse until
 * the call stack overflows.
 *
 * Per-prop (Y3/§4.1.3, NON-FATAL — drop the offending prop value and
 * keep decoding the rest of the tree): `prop-bytes` (encoded value
 * exceeds the byte ceiling, checked pre-parse), `prop-depth` (decoded
 * value nests too deep), `prop-array` (an array inside the value is too
 * long), `prop-nodes` (the decoded value holds too many total values).
 */
export type ReadGuardTrip =
	| "cycle"
	| "max-depth"
	| "max-nodes"
	| "prop-bytes"
	| "prop-depth"
	| "prop-array"
	| "prop-nodes";

export interface ReadGuardOptions {
	/** Maximum tree depth before bailing. Default 5000. */
	readonly maxDepth?: number;
	/** Maximum total node count before bailing. Default 200000. */
	readonly maxNodes?: number;
	/**
	 * Y3/§4.1.3 — per-prop decode bounds applied at the `JSON.parse`
	 * trust boundary in {@link parseNodeOwn}. Omit for the permissive
	 * defaults; see {@link PropGuardOptions}. These bounds always apply
	 * (defaults included), so EVERY decode path through `parseNodeOwn`
	 * is bounded — there is no un-guarded reader to bypass.
	 */
	readonly propGuards?: PropGuardOptions;
	/**
	 * Invoked the first time each distinct guard reason occurs in a read.
	 * Hosts wire this to `metrics.setDegraded(true, reason)` so a
	 * truncated decode or a dropped prop surfaces instead of silently
	 * losing data. A structural trip fires once then aborts; per-prop
	 * bounds may fire several distinct reasons across one read (each at
	 * most once) while the traversal continues.
	 */
	readonly onGuardTrip?: (reason: ReadGuardTrip) => void;
}

const DEFAULT_MAX_DEPTH = 5000;
const DEFAULT_MAX_NODES = 200000;

// Y3/§4.1.3 — permissive defaults for the per-prop decode bounds. Sized
// well above realistic PageIR (a 256 KiB encoded value, 64 levels of
// nesting, 100k array elements, 1M total values) so ordinary content is
// never clamped while a pathological hostile payload still trips.
const DEFAULT_PROP_MAX_BYTES = 256 * 1024;
const DEFAULT_PROP_MAX_DEPTH = 64;
const DEFAULT_PROP_MAX_ARRAY_LENGTH = 100_000;
const DEFAULT_PROP_MAX_NODES = 1_000_000;

interface ResolvedPropGuards {
	readonly maxBytes: number;
	readonly maxDepth: number;
	readonly maxArrayLength: number;
	readonly maxNodes: number;
}

interface ReadGuard {
	readonly visited: Set<string>;
	count: number;
	readonly maxDepth: number;
	readonly maxNodes: number;
	tripped: boolean;
	readonly propGuards: ResolvedPropGuards;
	/** Distinct reasons already surfaced this read (dedupes `onGuardTrip`). */
	readonly firedReasons: Set<ReadGuardTrip>;
	readonly onGuardTrip?: (reason: ReadGuardTrip) => void;
}

function createReadGuard(options?: ReadGuardOptions): ReadGuard {
	const p = options?.propGuards;
	return {
		visited: new Set<string>(),
		count: 0,
		maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxNodes: options?.maxNodes ?? DEFAULT_MAX_NODES,
		tripped: false,
		propGuards: {
			maxBytes: p?.maxBytes ?? DEFAULT_PROP_MAX_BYTES,
			maxDepth: p?.maxDepth ?? DEFAULT_PROP_MAX_DEPTH,
			maxArrayLength: p?.maxArrayLength ?? DEFAULT_PROP_MAX_ARRAY_LENGTH,
			maxNodes: p?.maxNodes ?? DEFAULT_PROP_MAX_NODES,
		},
		firedReasons: new Set<ReadGuardTrip>(),
		onGuardTrip: options?.onGuardTrip,
	};
}

/** Surface a guard reason to the host once per read, without aborting. */
function noteGuard(guard: ReadGuard, reason: ReadGuardTrip): void {
	if (guard.firedReasons.has(reason)) return;
	guard.firedReasons.add(reason);
	guard.onGuardTrip?.(reason);
}

/**
 * FATAL structural trip — record the reason and abort the rest of the
 * traversal (readNode bails at its top once `tripped` is set).
 */
function trip(guard: ReadGuard, reason: ReadGuardTrip): void {
	if (guard.tripped) return;
	guard.tripped = true;
	noteGuard(guard, reason);
}

/**
 * Y3/§4.1.3 — structure-bound a freshly decoded prop value. Iterative
 * (explicit stack) so a deeply nested value can never overflow the
 * validator's own call stack. Returns the FIRST bound exceeded, or
 * `undefined` when the value is within every limit. The `maxBytes`
 * ceiling is enforced separately on the encoded string BEFORE parse.
 */
function checkDecodedProp(
	value: unknown,
	limits: ResolvedPropGuards,
): "prop-depth" | "prop-array" | "prop-nodes" | undefined {
	let nodes = 0;
	const stack: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }];
	while (stack.length > 0) {
		const top = stack.pop();
		if (top === undefined) continue;
		const { v, depth } = top;
		nodes += 1;
		if (nodes > limits.maxNodes) return "prop-nodes";
		if (depth > limits.maxDepth) return "prop-depth";
		if (Array.isArray(v)) {
			if (v.length > limits.maxArrayLength) return "prop-array";
			for (let i = 0; i < v.length; i += 1) {
				stack.push({ v: v[i], depth: depth + 1 });
			}
		} else if (v !== null && typeof v === "object") {
			const obj = v as Record<string, unknown>;
			for (const key of Object.keys(obj)) {
				stack.push({ v: obj[key], depth: depth + 1 });
			}
		}
	}
	return undefined;
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
		const nodeMap = getOrCreateNodeMap(root, nativeNodeKey(node.id));
		writeNode(nodeMap, node, baselineNodes.get(node.id));
	});

	const baselineIds = new Set(baselineNodes.keys());
	for (const id of baselineIds) {
		if (!desiredIds.has(id)) root.delete(nativeNodeKey(id));
	}
}

/**
 * I1/§3.1 + P1 — local-save IR diff. Classifies a save as either:
 *
 * - `structural: true` — no prior IR or a root-id change. The caller
 *   must use the full {@link applyIRToNativeTree} (first save / new
 *   document).
 * - `structural: false` — everything else, including node add/remove
 *   and `childIds` reorder/membership (P1: previously forced the full
 *   apply). `changed` carries every node whose own fields, props,
 *   assets, meta OR child-id list differ from `prev` plus every added
 *   node; `removed` is every id in `prev` no longer present.
 *
 * `applyChangedNodesToNativeTree(changed, removed)` is byte-identical
 * to `applyIRToNativeTree(next, prev)`: `writeNode(node, prev[id])` on
 * any node NOT in `changed` is a guaranteed no-op (equal scalars,
 * `reconcileProps` writes nothing, `reconcileChildIds` early-returns
 * on an unchanged list), and deleting `removed` reproduces the full
 * apply's baseline sweep.
 */
export function diffIRNodesForLocalSave(
	prev: PageIR | undefined,
	next: PageIR,
	prevHashes?: ReadonlyMap<string, string>,
): {
	structural: boolean;
	changed: Map<string, PageIRNode>;
	baseline: Map<string, PageIRNode>;
	removed: Set<string>;
} {
	const structuralResult = {
		structural: true,
		changed: new Map<string, PageIRNode>(),
		baseline: new Map<string, PageIRNode>(),
		removed: new Set<string>(),
	};
	if (prev === undefined || prev.root.id !== next.root.id) {
		return structuralResult;
	}

	const prevById = new Map<string, PageIRNode>();
	walkNodes(prev.root, (n) => prevById.set(n.id, n));
	const nextById = new Map<string, PageIRNode>();
	walkNodes(next.root, (n) => nextById.set(n.id, n));

	const changed = new Map<string, PageIRNode>();
	const baseline = new Map<string, PageIRNode>();
	const removed = new Set<string>();
	for (const id of prevById.keys()) {
		if (!nextById.has(id)) removed.add(id);
	}
	for (const [id, n] of nextById) {
		const p = prevById.get(id);
		if (p === undefined) {
			// Added node — written fresh (no baseline entry, mirroring
			// `applyIRToNativeTree`'s `baselineNodes.get(id) === undefined`).
			changed.set(id, n);
			continue;
		}
		// Parent relink (childIds reorder/membership) is now carried in
		// `changed`, not escalated to a full rebuild (P1). Child id
		// lists are short string arrays — compared exactly and cheaply.
		const nKids = (n.children ?? []).map((c) => c.id);
		const pKids = (p.children ?? []).map((c) => c.id);
		const kidsDiffer =
			nKids.length !== pKids.length || nKids.some((k, i) => k !== pKids[i]);
		// P2 — when the live-IR cache supplied the prev-side content
		// hash, classify own-field changes with ONE hash of the next
		// node vs the cached prev hash, instead of stringifying
		// props/assets/meta of BOTH sides for every node every save.
		// hashNodeContent covers exactly {type,slot,slotKind,props,
		// assets,meta} so this is classification-equivalent to the
		// stringify path (same determinism/collision profile as
		// pageIRHash, which the codebase already relies on). Falls back
		// to the exact stringify compare when no hash is available
		// (first save, cache miss) so the result is never weaker.
		const prevHash = prevHashes?.get(id);
		const contentChanged =
			prevHash !== undefined
				? hashNodeContent(n) !== prevHash
				: n.type !== p.type ||
					n.slot !== p.slot ||
					n.slotKind !== p.slotKind ||
					JSON.stringify(n.props ?? {}) !== JSON.stringify(p.props ?? {}) ||
					JSON.stringify(n.assets ?? null) !==
						JSON.stringify(p.assets ?? null) ||
					JSON.stringify(n.meta ?? null) !== JSON.stringify(p.meta ?? null);
		if (kidsDiffer || contentChanged) {
			changed.set(id, n);
			baseline.set(id, p);
		}
	}
	return { structural: false, changed, baseline, removed };
}

/**
 * Incremental sibling of {@link applyIRToNativeTree}: writes only the
 * nodes in `changed`, deletes `removed`, and conditionally updates the
 * root version/assets/metadata. Byte-identical to the full apply for
 * any `!structural` {@link diffIRNodesForLocalSave} result (including
 * P1 relinks — add / remove / reorder), because skipped nodes would
 * have produced no Y.Doc mutation and the `removed` deletion
 * reproduces the full apply's baseline sweep.
 */
export function applyChangedNodesToNativeTree(
	root: Y.Map<unknown>,
	ir: PageIR,
	prevIR: PageIR | undefined,
	changed: ReadonlyMap<string, PageIRNode>,
	baseline: ReadonlyMap<string, PageIRNode>,
	removed?: ReadonlySet<string>,
): void {
	// Root-level writes use the EXACT conditions of the full
	// `applyIRToNativeTree` (compare next vs the prior IR) so the
	// resulting Y.Doc is byte-identical — this path only omits the
	// per-node writes that would have been no-ops anyway.
	if (root.get(NATIVE_VERSION_KEY) !== ir.version) {
		root.set(NATIVE_VERSION_KEY, ir.version);
	}
	if (root.get(NATIVE_ROOT_ID_KEY) !== ir.root.id) {
		root.set(NATIVE_ROOT_ID_KEY, ir.root.id);
	}
	const newAssets = JSON.stringify(ir.assets ?? []);
	const baseAssets = JSON.stringify(prevIR?.assets ?? []);
	if (newAssets !== baseAssets) root.set(NATIVE_ASSETS_KEY, newAssets);
	const newMeta = JSON.stringify(ir.metadata ?? {});
	const baseMeta = JSON.stringify(prevIR?.metadata ?? {});
	if (newMeta !== baseMeta) root.set(NATIVE_METADATA_KEY, newMeta);
	for (const [id, node] of changed) {
		const nodeMap = getOrCreateNodeMap(root, nativeNodeKey(id));
		writeNode(nodeMap, node, baseline.get(id));
	}
	// P1 — reproduce the full apply's baseline sweep for relink saves
	// that removed nodes.
	if (removed) for (const id of removed) root.delete(nativeNodeKey(id));
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

/** P1 — topology delta; see {@link RelinkDelta} in `types.ts`. */
export interface DerivedRelink {
	addedIds: Set<string>;
	removedIds: Set<string>;
	parentsTouched: Set<string>;
}

/**
 * Map a batch of `Y.Map.observeDeep` events into the set of node ids
 * whose subtree changed (H3) plus a topology classification (P1).
 *
 * - `structural: true` — a whole-document change (`version`/`rootId`/
 *   `assets`/`metadata`) or anything ambiguous. The live-IR cache
 *   must fall back to a full guarded `readNativeTree`.
 * - `relink` present (and `structural: false`) — a `node:<id>` map
 *   added/removed at the root and/or a `childIds` reorder/membership
 *   change. The cache relinks only the affected subtrees: it re-reads
 *   the added/parent nodes' shallow fields and re-materializes from
 *   the cached (already-parsed) props of every untouched node,
 *   instead of re-`JSON.parse`-ing the whole document on every peer.
 * - neither — a pure node-local prop patch (existing fast path).
 */
export function deriveChangedNodeIds(
	events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
): {
	ids: Set<string>;
	structural: boolean;
	relink?: DerivedRelink;
} {
	const ids = new Set<string>();
	const addedIds = new Set<string>();
	const removedIds = new Set<string>();
	const parentsTouched = new Set<string>();
	let structural = false;
	for (const event of events) {
		const path = event.path;
		if (path.length === 0) {
			// Event on the tree root map itself.
			for (const [key, change] of event.changes.keys) {
				if (
					key === NATIVE_VERSION_KEY ||
					key === NATIVE_ROOT_ID_KEY ||
					key === NATIVE_ASSETS_KEY ||
					key === NATIVE_METADATA_KEY
				) {
					// Whole-document change — genuine full rebuild.
					structural = true;
				} else if (key.startsWith(NATIVE_NODE_PREFIX)) {
					// A whole node Y.Map was added or removed at the root.
					// Recorded as a relink (re-read just this node /
					// drop it) rather than a full re-parse of every node.
					const id = key.slice(NATIVE_NODE_PREFIX.length);
					ids.add(id);
					if (change.action === "delete") removedIds.add(id);
					else addedIds.add(id);
				}
			}
			continue;
		}
		const first = path[0];
		if (typeof first !== "string" || !first.startsWith(NATIVE_NODE_PREFIX)) {
			continue;
		}
		const ownerId = first.slice(NATIVE_NODE_PREFIX.length);
		ids.add(ownerId);
		// A `childIds` reorder/membership change relinks the tree. The
		// cache re-reads just this parent's child id list and rebuilds
		// from cached node props — no whole-document re-parse.
		if (path.includes("childIds")) parentsTouched.add(ownerId);
	}
	const hasRelink =
		addedIds.size > 0 || removedIds.size > 0 || parentsTouched.size > 0;
	if (structural || !hasRelink) {
		return { ids, structural };
	}
	return {
		ids,
		structural: false,
		relink: { addedIds, removedIds, parentsTouched },
	};
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

	reconcileProps(getOrCreatePropsMap(map), node.props, baseline?.props);

	reconcileChildIds(
		getOrCreateChildIds(map),
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
	reconcileKeyedArray(target, baseIds, desired);
}

/**
 * CRDT-safe keyed reconcile for a child-id `Y.Array` (I5).
 *
 * The previous implementation did `target.delete(0, len)` +
 * `target.insert(0, desired)` on ANY change. Two replicas concurrently
 * editing the same parent's `childIds` then each replaced the whole
 * array; Yjs still converges, but to a *garbled* union (duplicated /
 * dropped children) — disjoint structural intents did NOT both survive.
 *
 * This instead derives the LOCAL delta (`baseIds → desiredIds`) and
 * applies only minimal, position-targeted ops against the array's
 * **live** contents (which may already carry a remote peer's
 * concurrent ops), mirroring how {@link reconcileProps} writes only the
 * keys the local session changed. It is idempotent under server echo
 * (ops whose effect is already present are skipped), so a peer's own
 * write coming back through the relay is a no-op.
 *
 * Guarantees for concurrent **disjoint** structural edits (the I5
 * acceptance case): a remote peer's added/removed ids are never
 * clobbered, the local peer's add/remove/reorder all apply, and both
 * replicas converge to the same sensible array. Concurrent reorders of
 * the *same* ids by two peers have no canonical CRDT answer; Yjs still
 * converges deterministically and the result is strictly better than
 * the old whole-array replacement.
 */
function reconcileKeyedArray(
	target: Y.Array<string>,
	baseIds: readonly string[],
	desiredIds: readonly string[],
): void {
	// Single live read; all index math is done on the `work` JS mirror
	// and translated to targeted Y.Array ops. (The previous version
	// called `target.toArray()` + `indexOf` inside loops — O(n²/n³) and
	// 2000 individual inserts on a first 2000-child build, which bloated
	// the seed update and blew the hydration budget.)
	const cur = target.toArray();
	if (sameList(cur, desiredIds)) return; // already converged / echo

	// Fast path: nothing local to preserve a delta against (fresh node,
	// L1 migration, first save). One bulk insert — O(n), one op, exactly
	// like the pre-I5 behaviour for the non-concurrent build path.
	if (cur.length === 0) {
		if (desiredIds.length > 0) target.insert(0, [...desiredIds]);
		return;
	}

	const desiredSet = new Set(desiredIds);
	const baseSet = new Set(baseIds);

	// 1. Removals the LOCAL peer intends (in base, no longer desired),
	//    only where still present. Collect indices in one pass and
	//    delete high→low so earlier indices stay valid. A concurrent
	//    remote delete (id already gone) is simply not in `cur` → no-op,
	//    so we never disturb it.
	const work: string[] = [];
	for (const id of cur) {
		if (baseSet.has(id) && !desiredSet.has(id)) continue; // local remove
		work.push(id);
	}
	for (let i = cur.length - 1; i >= 0; i -= 1) {
		const id = cur[i] as string;
		if (baseSet.has(id) && !desiredSet.has(id)) target.delete(i, 1);
	}

	// 2. Additions the LOCAL peer made (in desired, not in base),
	//    inserted in desired order after the nearest preceding desired
	//    id that currently exists. Skip ids already present (remote
	//    concurrent add / echo) so a child is never duplicated.
	for (let di = 0; di < desiredIds.length; di += 1) {
		const id = desiredIds[di] as string;
		if (baseSet.has(id)) continue;
		if (work.includes(id)) continue;
		let insertAt = 0;
		for (let k = di - 1; k >= 0; k -= 1) {
			const pi = work.indexOf(desiredIds[k] as string);
			if (pi >= 0) {
				insertAt = pi + 1;
				break;
			}
		}
		target.insert(insertAt, [id]);
		work.splice(insertAt, 0, id);
	}

	// 3. Reorder — only among ids the local peer controls (present AND
	//    desired). Ids present but neither desired nor in base were
	//    inserted concurrently by a remote peer: never move or drop them
	//    (their absolute slots are preserved). Move only misplaced
	//    controlled ids via targeted delete+insert, never the whole
	//    array, so a remote peer's disjoint ops survive the merge.
	for (let slot = 0; slot < desiredIds.length; slot += 1) {
		const wantId = desiredIds[slot] as string;
		let seen = -1;
		let absIndex = -1;
		for (let i = 0; i < work.length; i += 1) {
			if (desiredSet.has(work[i] as string)) {
				seen += 1;
				if (seen === slot) {
					absIndex = i;
					break;
				}
			}
		}
		if (absIndex < 0) continue;
		if (work[absIndex] === wantId) continue;
		const fromIndex = work.indexOf(wantId);
		if (fromIndex < 0) continue;
		target.delete(fromIndex, 1);
		work.splice(fromIndex, 1);
		const insertAt = fromIndex < absIndex ? absIndex - 1 : absIndex;
		target.insert(insertAt, [wantId]);
		work.splice(insertAt, 0, wantId);
	}
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
	const own = parseNodeOwn(root, id, guard);
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

/**
 * Parse one node's own fields + child id list (no recursion). The
 * optional {@link ReadGuardOptions} threads the Y3 per-prop decode
 * bounds (and the `onGuardTrip` metric hook) through the live-IR cache's
 * incremental re-reads; omit them and the permissive defaults still
 * apply, so this path is never an un-bounded bypass.
 */
export function readNodeShallow(
	root: Y.Map<unknown>,
	id: string,
	options?: ReadGuardOptions,
): ShallowNativeNode | undefined {
	return parseNodeOwn(root, id, createReadGuard(options));
}

function parseNodeOwn(
	root: Y.Map<unknown>,
	id: string,
	guard: ReadGuard,
): { node: Record<string, unknown>; childIds: string[] } | undefined {
	const map = getNodeMap(root, id);
	if (map === undefined) return undefined;
	const type = map.get("type");
	if (typeof type !== "string") return undefined;
	const propsMap = getPropsMap(map);
	const props: Record<string, unknown> = {};
	if (propsMap !== undefined) {
		// Y3/§4.1.3 — TRUST BOUNDARY: prop values are JSON-parsed from
		// peer-authored doc state. A single prop VALUE is now bounded at
		// this boundary: the encoded string is size-checked BEFORE parse,
		// and the decoded value is depth/array/node-count-checked AFTER
		// parse. A prop that exceeds any bound is DROPPED (the node and the
		// rest of the tree still decode — one hostile prop can't blank the
		// document) and the matching reason is recorded via `onGuardTrip`
		// so the adapter surfaces a degraded metric rather than admitting
		// the payload or stalling the main thread.
		const pg = guard.propGuards;
		for (const [key, raw] of propsMap.entries()) {
			if (typeof raw !== "string") continue;
			// Pre-parse byte ceiling — a multi-megabyte string never reaches
			// JSON.parse.
			if (raw.length > pg.maxBytes) {
				noteGuard(guard, "prop-bytes");
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// drop malformed prop value
				continue;
			}
			const violation = checkDecodedProp(parsed, pg);
			if (violation !== undefined) {
				noteGuard(guard, violation);
				continue;
			}
			props[key] = parsed;
		}
	}
	const childIdsRaw = getChildIds(map);
	const childIds: string[] = [];
	if (childIdsRaw !== undefined) {
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
