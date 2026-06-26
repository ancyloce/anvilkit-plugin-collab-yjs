import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import type * as Y from "yjs";

import type { PropGuardOptions } from "../types/types.js";
import { hashNodeContent } from "./encode.js";

import {
	NATIVE_ASSETS_KEY,
	NATIVE_METADATA_KEY,
	NATIVE_ROOT_ID_KEY,
} from "./keys.js";
import {
	type DerivedRelink,
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
 * P1 (formerly deferred I3): a `childIds` reorder / node add / node
 * remove no longer forces a full `readNativeTree` re-parse. The
 * adapter classifies it as a {@link DerivedRelink} and the cache
 * re-reads only the affected parents + added nodes (shallow) and
 * relinks the tree from already-parsed props. Only a genuine whole-
 * document change (root id / version / assets / metadata) or an
 * ambiguous event still falls back to the full guarded rebuild —
 * which remains the correctness backstop. `pnpm bench:collab-highload`
 * gates it.
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
	 * I1/§3.1 — incremental sibling of {@link setLocal}. Updates only
	 * the `changed` node entries (+ root assets/metadata/id) instead
	 * of clearing and re-walking the whole tree. Caller guarantees a
	 * non-structural save (same id-set, unchanged `childIds`), so the
	 * materialized result is identical to `setLocal(ir)`. Falls back
	 * to a full seed if the cache was never seeded.
	 */
	setLocalChanged(
		ir: PageIR,
		changed: ReadonlyMap<string, PageIRNode>,
		removed?: ReadonlySet<string>,
	): void;
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
		relink?: DerivedRelink,
	): PageIR | undefined;
	/**
	 * P2 — current per-node content hashes (id → hash) of the cached
	 * (last-saved/converged) tree. `diffIRNodesForLocalSave` uses these
	 * as the prev-side baseline so a local save is classified with one
	 * hash per next-node instead of re-stringifying every node twice.
	 */
	getNodeHashes(): ReadonlyMap<string, string>;
}

interface CachedNode {
	node: Record<string, unknown>;
	childIds: readonly string[];
	/** P2 — content hash of this node's own fields (see encode.ts). */
	hash: string;
}

export interface LiveIROptions {
	/** Forwarded to the guarded native-tree reads (M4). */
	readonly onGuardTrip?: (reason: ReadGuardTrip) => void;
	/**
	 * Y3/§4.1.3 — per-prop decode bounds forwarded to every native-tree
	 * read this cache performs (full rebuild + incremental shallow
	 * re-reads), so a hostile prop value is bounded on the remote-event
	 * decode path too.
	 */
	readonly propGuards?: PropGuardOptions;
}

export function createLiveIRState(options?: LiveIROptions): LiveIRState {
	const cache = new Map<string, CachedNode>();
	// F10 — a live id → hash map kept in lock-step with `cache` at every
	// set/delete/clear site below, so `getNodeHashes()` can return it
	// directly instead of allocating a fresh `Map` over the whole cache on
	// every save. The hash already lives inside each `CachedNode`; this
	// just exposes it without the per-save clone.
	const hashes = new Map<string, string>();
	let rootId: string | undefined;
	let assets: PageIR["assets"] = [];
	let metadata: PageIR["metadata"] = {};
	let seeded = false;

	function seedFromIR(ir: PageIR): void {
		cache.clear();
		hashes.clear();
		rootId = ir.root.id;
		assets = ir.assets;
		metadata = ir.metadata;
		const stack: PageIRNode[] = [ir.root];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			const { children, ...own } = node;
			const hash = hashNodeContent(node);
			cache.set(node.id, {
				node: { ...own },
				childIds: children ? children.map((c) => c.id) : [],
				hash,
			});
			hashes.set(node.id, hash);
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
			propGuards: options?.propGuards,
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
		setLocalChanged(ir, changed, removed): void {
			if (!seeded) {
				seedFromIR(ir);
				return;
			}
			rootId = ir.root.id;
			assets = ir.assets;
			metadata = ir.metadata;
			// P1 — `changed` carries relinked parents (new childIds) and
			// added nodes too, so updating those entries plus dropping
			// `removed` keeps the materialized tree identical to a full
			// `setLocal(ir)` for a relink local save.
			if (removed)
				for (const id of removed) {
					cache.delete(id);
					hashes.delete(id);
				}
			for (const [id, node] of changed) {
				const { children, ...own } = node;
				const hash = hashNodeContent(node);
				cache.set(id, {
					node: { ...own },
					childIds: children ? children.map((c) => c.id) : [],
					hash,
				});
				hashes.set(id, hash);
			}
		},
		applyRemoteFullBlob: seedFromIR,
		applyRemoteChangedNodes(
			treeRoot,
			ids,
			structural,
			relink,
		): PageIR | undefined {
			if (structural || !seeded) {
				return fullRebuild(treeRoot);
			}
			readRootMeta(treeRoot);
			// P1 — re-read the changed nodes plus, for a relink, every
			// parent whose `childIds` shifted and every newly added
			// node. Removed nodes are dropped from the cache. Untouched
			// nodes keep their already-parsed props (never re-
			// `JSON.parse`d) and `materialize()` rebuilds the tree from
			// the relinked child id lists.
			const removed = relink?.removedIds;
			const toRead = new Set<string>(ids);
			if (relink) {
				for (const id of relink.parentsTouched) toRead.add(id);
				for (const id of relink.addedIds) toRead.add(id);
			}
			for (const id of toRead) {
				if (removed?.has(id)) {
					cache.delete(id);
					hashes.delete(id);
					continue;
				}
				const shallow = readNodeShallow(treeRoot, id, {
					onGuardTrip: options?.onGuardTrip,
					propGuards: options?.propGuards,
				});
				if (!shallow) {
					// A changed node vanished or is unreadable under a
					// "non-structural" classification — be conservative
					// and rebuild the whole tree so we never emit a stale
					// or partial IR to conflict detection / Puck.
					return fullRebuild(treeRoot);
				}
				const hash = hashNodeContent(shallow.node as unknown as PageIRNode);
				cache.set(id, {
					node: shallow.node,
					childIds: shallow.childIds,
					hash,
				});
				hashes.set(id, hash);
			}
			if (removed)
				for (const id of removed) {
					cache.delete(id);
					hashes.delete(id);
				}
			return materialize();
		},
		getNodeHashes(): ReadonlyMap<string, string> {
			// F10 — return the live `hashes` map directly (no per-save
			// clone). The sole consumer, `diffIRNodesForLocalSave` in
			// `snapshots.save()`, reads it synchronously (read-only `.get()`
			// inside its own loop) BEFORE the next cache mutation, so the
			// shared reference is safe. Kept in lock-step with `cache` at
			// every set/delete/clear site above.
			return hashes;
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
