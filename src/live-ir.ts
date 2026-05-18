import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import type * as Y from "yjs";

import {
	NATIVE_ASSETS_KEY,
	NATIVE_METADATA_KEY,
	NATIVE_ROOT_ID_KEY,
} from "./keys.js";
import {
	type ReadGuardTrip,
	readNativeTree,
	readNodeShallow,
} from "./native-tree.js";

/**
 * In-memory authoritative live `PageIR` for the native-tree encoding
 * (H3). Without it, every remote Yjs event reconstructed the WHOLE
 * document — `readNativeTree` re-`JSON.parse`s every prop of every node
 * even when a single remote keystroke touched one prop. On a 2000-node
 * page that is O(document) work on the main thread per inbound update.
 *
 * The cache keeps each node's parsed own-fields + ordered child id list
 * keyed by id. A remote event re-reads only the changed nodes
 * (`applyRemoteChangedNodes`) and the tree is relinked from the cache —
 * unchanged nodes are never re-parsed. A structural change (rootId /
 * version / assets / metadata / childIds / node add-remove) falls back
 * to a full guarded `readNativeTree` so conflict overlap stays exactly
 * as correct as before.
 *
 * The materialized IR is rebuilt fresh on every `get()` so callers that
 * retain it (`conflicts.setLastLocalIR`) never alias the cache.
 *
 * Accuracy note (I9): this makes the *remote read* path incremental
 * (changed nodes only). It does NOT make the *local save* path
 * incremental — `snapshots.save()` still re-encodes/walks the whole IR
 * per keystroke (deferred review item I1). A `childIds` change is still
 * (correctly) classified structural by `deriveChangedNodeIds`, forcing
 * a full rebuild here; decoupling that is the deferred I3 perf work,
 * not a correctness concern. `pnpm bench:collab-highload` gates both.
 */
export interface LiveIRState {
	/** Current materialized live IR, or `undefined` until seeded. */
	get(): PageIR | undefined;
	/**
	 * Seed/replace the cache from a known-good local IR. Called by
	 * `snapshots.save()` after `applyIRToNativeTree` so the live view
	 * matches what was just written without re-reading Yjs.
	 */
	setLocal(ir: PageIR): void;
	/**
	 * Seed/replace the cache from a decoded legacy `PAGE_IR_KEY` blob
	 * (old/legacy-mode peers, hydration, force-resync).
	 */
	applyRemoteFullBlob(ir: PageIR): void;
	/**
	 * Apply a batch of remote changes. `ids` are the node ids whose
	 * subtree changed; `structural` forces a full rebuild. Returns the
	 * new materialized IR, or `undefined` if the tree cannot be decoded.
	 */
	applyRemoteChangedNodes(
		treeRoot: Y.Map<unknown>,
		ids: ReadonlySet<string>,
		structural: boolean,
	): PageIR | undefined;
}

interface CachedNode {
	node: Record<string, unknown>;
	childIds: readonly string[];
}

export interface LiveIROptions {
	/** Forwarded to the guarded native-tree reads (M4). */
	readonly onGuardTrip?: (reason: ReadGuardTrip) => void;
}

export function createLiveIRState(options?: LiveIROptions): LiveIRState {
	const cache = new Map<string, CachedNode>();
	let rootId: string | undefined;
	let assets: PageIR["assets"] = [];
	let metadata: PageIR["metadata"] = {};
	let seeded = false;

	function seedFromIR(ir: PageIR): void {
		cache.clear();
		rootId = ir.root.id;
		assets = ir.assets;
		metadata = ir.metadata;
		const stack: PageIRNode[] = [ir.root];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			const { children, ...own } = node;
			cache.set(node.id, {
				node: { ...own },
				childIds: children ? children.map((c) => c.id) : [],
			});
			if (children) for (const c of children) stack.push(c);
		}
		seeded = true;
	}

	function readRootMeta(treeRoot: Y.Map<unknown>): void {
		const id = treeRoot.get(NATIVE_ROOT_ID_KEY);
		if (typeof id === "string") rootId = id;
		assets = parseJSONOr(treeRoot.get(NATIVE_ASSETS_KEY), []);
		metadata = parseJSONOr(treeRoot.get(NATIVE_METADATA_KEY), {});
	}

	function fullRebuild(treeRoot: Y.Map<unknown>): PageIR | undefined {
		const ir = readNativeTree(treeRoot, {
			onGuardTrip: options?.onGuardTrip,
		});
		if (!ir) return undefined;
		seedFromIR(ir);
		// `readNativeTree` already produced a fresh, independent tree —
		// hand it back directly rather than re-materializing.
		return ir;
	}

	function materialize(): PageIR | undefined {
		if (!seeded || rootId === undefined) return undefined;
		const visited = new Set<string>();
		const build = (id: string): PageIRNode | undefined => {
			if (visited.has(id)) return undefined; // cycle guard
			const cached = cache.get(id);
			if (!cached) return undefined;
			visited.add(id);
			const children: PageIRNode[] = [];
			for (const childId of cached.childIds) {
				const child = build(childId);
				if (child) children.push(child);
			}
			const node: Record<string, unknown> = { ...cached.node };
			if (children.length > 0) node.children = children;
			return node as unknown as PageIRNode;
		};
		const root = build(rootId);
		if (!root) return undefined;
		return { version: "1", root, assets, metadata } as PageIR;
	}

	return {
		get: materialize,
		setLocal: seedFromIR,
		applyRemoteFullBlob: seedFromIR,
		applyRemoteChangedNodes(treeRoot, ids, structural): PageIR | undefined {
			if (structural || !seeded) {
				return fullRebuild(treeRoot);
			}
			readRootMeta(treeRoot);
			for (const id of ids) {
				const shallow = readNodeShallow(treeRoot, id);
				if (!shallow) {
					// A changed node vanished or is unreadable under a
					// "non-structural" classification — be conservative
					// and rebuild the whole tree so we never emit a stale
					// or partial IR to conflict detection / Puck.
					return fullRebuild(treeRoot);
				}
				cache.set(id, {
					node: shallow.node,
					childIds: shallow.childIds,
				});
			}
			return materialize();
		},
	};
}

function parseJSONOr<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== "string") return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}
