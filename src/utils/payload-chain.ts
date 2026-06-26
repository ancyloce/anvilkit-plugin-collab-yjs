/**
 * @file Differential snapshot payload storage ("delta-chain") for the
 * Yjs collab adapter.
 *
 * Previously `save()` wrote the **entire** encoded `PageIR` to the shared
 * `Y.Map` on every keystroke — `O(saves × document)` CRDT growth (the
 * high-load report's runaway RSS). This module stores every
 * {@link KEYFRAME_INTERVAL}-th snapshot whole (a *keyframe*) and the saves
 * in between as a small **delta** against the immediately previous
 * snapshot: only the nodes that actually changed (their own content +
 * child-id list) plus the ids that were removed, plus the page-level
 * `assets`/`metadata` verbatim (those live outside the node tree).
 *
 * The delta is built directly from the adapter's already-computed
 * `O(changed)` local-save classification (`diffIRNodesForLocalSave`), so
 * the save hot path stays `O(changed)` — it never re-diffs or re-applies
 * the whole document. Reconstruction (`reconstructPayload`, on the rare
 * `load`/`forceResync` path) walks `base` pointers back to the nearest
 * keyframe and replays the deltas by **node id**, which is byte-identical
 * to `applyChangedNodesToNativeTree` (the same trusted invariant the
 * native-tree apply relies on): a non-root-change save is fully described
 * by {changed-by-id, removed, unchanged-from-base}, so no per-delta
 * round-trip validation is needed.
 *
 * Back-compat: payloads written before the delta-chain are raw encoded
 * `PageIR` JSON; {@link decodePayload} reads them transparently as
 * keyframes. The root id never changes within a chain (a root-id change
 * forces a keyframe upstream), so reconstruction can assume a stable root.
 */

import type { PageIR, PageIRNode } from "@anvilkit/core/types";

/** Keyframe spacing: at most this many deltas chain off one keyframe. */
export const KEYFRAME_INTERVAL = 20;

/**
 * A node's own content (everything except the nested `children`) plus the
 * ordered ids of its children — enough to rebuild the tree against a base
 * snapshot without serializing unchanged subtrees (so even a root reorder
 * stays `O(changed)`, not `O(document)`).
 */
interface StoredNode {
	readonly id: string;
	readonly type: string;
	readonly props: PageIRNode["props"];
	readonly slot?: string;
	readonly slotKind?: PageIRNode["slotKind"];
	readonly assets?: PageIRNode["assets"];
	readonly meta?: PageIRNode["meta"];
	/**
	 * Ordered child ids, or `undefined` when the node has no `children`
	 * key at all. `[]` (an empty array) is preserved distinctly from
	 * `undefined` so reconstruction round-trips byte-for-byte with a node
	 * that carries an explicit empty `children: []` (the canonical leaf
	 * form omits the key — both must survive a delta replay unchanged).
	 */
	readonly childIds?: readonly string[];
}

/** Stored payload: a self-contained keyframe or a delta against `base`. */
export type StoredPayload =
	| { readonly kind: "full"; readonly ir: PageIR }
	| {
			readonly kind: "delta";
			readonly base: string;
			readonly changed: readonly StoredNode[];
			readonly removed: readonly string[];
			readonly assets: PageIR["assets"];
			readonly metadata: PageIR["metadata"];
	  };

/** Per-record persistence the chain logic is layered on (a `Y.Map` view). */
export interface PayloadBackend {
	read(id: string): StoredPayload | undefined;
	write(id: string, payload: StoredPayload): void;
	orderedIds(): readonly string[];
}

type MutableNode = {
	id: string;
	type: string;
	props: PageIRNode["props"];
	slot?: string;
	slotKind?: PageIRNode["slotKind"];
	assets?: PageIRNode["assets"];
	meta?: PageIRNode["meta"];
	children?: PageIRNode[];
};

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strip the nested subtree, keeping own content + the ordered child ids. */
function toStoredNode(node: PageIRNode): StoredNode {
	const stored: {
		id: string;
		type: string;
		props: PageIRNode["props"];
		slot?: string;
		slotKind?: PageIRNode["slotKind"];
		assets?: PageIRNode["assets"];
		meta?: PageIRNode["meta"];
		childIds?: string[];
	} = {
		id: node.id,
		type: node.type,
		props: node.props,
	};
	if (node.slot !== undefined) stored.slot = node.slot;
	if (node.slotKind !== undefined) stored.slotKind = node.slotKind;
	if (node.assets !== undefined) stored.assets = node.assets;
	if (node.meta !== undefined) stored.meta = node.meta;
	// Preserve children-key presence (absent vs explicit `[]`).
	if (node.children !== undefined) {
		stored.childIds = node.children.map((child) => child.id);
	}
	return stored;
}

function fromStoredNode(
	stored: StoredNode,
	children: PageIRNode[] | undefined,
): PageIRNode {
	const node: MutableNode = {
		id: stored.id,
		type: stored.type,
		props: stored.props,
	};
	if (stored.slot !== undefined) node.slot = stored.slot;
	if (stored.slotKind !== undefined) node.slotKind = stored.slotKind;
	if (stored.assets !== undefined) node.assets = stored.assets;
	if (stored.meta !== undefined) node.meta = stored.meta;
	if (children !== undefined) node.children = children;
	return node as PageIRNode;
}

/**
 * Build the delta payload for a non-root-change save from the adapter's
 * `O(changed)` local-save classification. The page-level `assets`/
 * `metadata` are stored verbatim (they are not part of the node tree).
 */
export function buildDeltaPayload(args: {
	readonly base: string;
	readonly ir: PageIR;
	readonly changed: ReadonlyMap<string, PageIRNode>;
	readonly removed: ReadonlySet<string>;
}): StoredPayload {
	const changed: StoredNode[] = [];
	for (const node of args.changed.values()) changed.push(toStoredNode(node));
	return {
		kind: "delta",
		base: args.base,
		changed,
		removed: [...args.removed],
		assets: args.ir.assets,
		metadata: args.ir.metadata,
	};
}

export function encodePayload(payload: StoredPayload): string {
	return JSON.stringify(payload);
}

/**
 * Parse a stored payload string, transparently upgrading legacy
 * raw-`PageIR` payloads (written before the delta-chain) to keyframes.
 * Throws on an unrecognized/corrupt shape — callers map that to the
 * adapter's `SnapshotCorruptedError`.
 */
export function decodePayload(raw: string): StoredPayload {
	const parsed: unknown = JSON.parse(raw);
	if (isObject(parsed)) {
		if (parsed.kind === "full") {
			if (isPageIR(parsed.ir)) return { kind: "full", ir: parsed.ir };
			// §4.2.4 — distinguish a wrong PAYLOAD VERSION from a wholly
			// unrecognized blob so the corruption report is actionable.
			throw new Error(
				`plugin-collab-yjs: keyframe payload has an unsupported PageIR version (expected "1", got ${describeVersion(
					parsed.ir,
				)})`,
			);
		}
		if (parsed.kind === "delta") {
			return decodeDeltaPayload(parsed);
		}
		// Legacy: raw encoded PageIR JSON (no `kind`).
		if (isPageIR(parsed)) {
			return { kind: "full", ir: parsed };
		}
	}
	throw new Error("plugin-collab-yjs: unrecognized snapshot payload shape");
}

/**
 * §4.2.4 — validate a delta payload record beyond its outer array shape:
 * every `changed` entry must be a structurally-valid {@link StoredNode}
 * and every `removed` entry a non-empty string. Replaying a delta whose
 * `changed` carries a malformed node silently corrupts the reconstructed
 * tree (the orphan node is dropped) instead of surfacing the fault — so
 * reject it here and let the caller map the throw to a typed
 * `SnapshotCorruptedError`.
 */
function decodeDeltaPayload(parsed: Record<string, unknown>): StoredPayload {
	if (
		typeof parsed.base !== "string" ||
		parsed.base.length === 0 ||
		!Array.isArray(parsed.changed) ||
		!Array.isArray(parsed.removed) ||
		!Array.isArray(parsed.assets) ||
		!isObject(parsed.metadata)
	) {
		throw new Error("plugin-collab-yjs: malformed delta payload record");
	}
	for (const node of parsed.changed) {
		if (!isStoredNode(node)) {
			throw new Error(
				"plugin-collab-yjs: malformed delta payload — a changed entry is not a valid stored node",
			);
		}
	}
	for (const id of parsed.removed) {
		if (typeof id !== "string" || id.length === 0) {
			throw new Error(
				"plugin-collab-yjs: malformed delta payload — a removed id is not a non-empty string",
			);
		}
	}
	return parsed as unknown as StoredPayload;
}

/** §4.2.4 — a stored delta node carries enough to rebuild against a base. */
function isStoredNode(value: unknown): value is StoredNode {
	if (!isObject(value)) return false;
	if (typeof value.id !== "string" || value.id.length === 0) return false;
	if (typeof value.type !== "string") return false;
	if (!isObject(value.props)) return false;
	if (value.slot !== undefined && typeof value.slot !== "string") return false;
	if (value.childIds !== undefined) {
		if (!Array.isArray(value.childIds)) return false;
		if (!value.childIds.every((child) => typeof child === "string")) {
			return false;
		}
	}
	return true;
}

function isPageIR(value: unknown): value is PageIR {
	return isObject(value) && value.version === "1" && isObject(value.root);
}

/** Render a payload's PageIR version for a corruption message. */
function describeVersion(ir: unknown): string {
	if (isObject(ir) && "version" in ir) return JSON.stringify(ir.version);
	return "a non-PageIR value";
}

/**
 * Reconstruct the full `PageIR` for `id` by walking `base` pointers to the
 * nearest keyframe and replaying the deltas by node id. Throws on a
 * missing/cyclic chain record.
 */
export function reconstructPayload(
	backend: PayloadBackend,
	id: string,
): PageIR {
	return reconstruct(backend, id, new Set());
}

function reconstruct(
	backend: PayloadBackend,
	id: string,
	seen: Set<string>,
): PageIR {
	if (seen.has(id)) {
		throw new Error(`plugin-collab-yjs: snapshot chain cycle at "${id}"`);
	}
	seen.add(id);

	const payload = backend.read(id);
	if (!payload) {
		throw new Error(
			`plugin-collab-yjs: snapshot chain references a missing record "${id}"`,
		);
	}
	if (payload.kind === "full") {
		return payload.ir;
	}

	const base = reconstruct(backend, payload.base, seen);
	return applyStoredDelta(base, payload);
}

function applyStoredDelta(
	base: PageIR,
	delta: Extract<StoredPayload, { kind: "delta" }>,
): PageIR {
	// Flatten the base tree into own-content-by-id, then overlay the
	// delta's removed/changed sets and rebuild from the (stable) root id.
	const own = new Map<string, StoredNode>();
	const walk = (node: PageIRNode): void => {
		own.set(node.id, toStoredNode(node));
		for (const child of node.children ?? []) walk(child);
	};
	walk(base.root);

	for (const id of delta.removed) own.delete(id);
	for (const node of delta.changed) own.set(node.id, node);

	const visiting = new Set<string>();
	const build = (id: string): PageIRNode => {
		if (visiting.has(id)) {
			throw new Error(
				`plugin-collab-yjs: cycle while reconstructing node "${id}"`,
			);
		}
		visiting.add(id);
		const stored = own.get(id);
		if (!stored) {
			throw new Error(
				`plugin-collab-yjs: delta references missing node "${id}"`,
			);
		}
		const children =
			stored.childIds === undefined ? undefined : stored.childIds.map(build);
		visiting.delete(id);
		return fromStoredNode(stored, children);
	};

	return {
		version: "1",
		root: build(base.root.id),
		assets: delta.assets,
		metadata: delta.metadata,
	};
}
