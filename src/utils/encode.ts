import type { PageIR, PageIRNode } from "@anvilkit/core/types";

/**
 * Serialize a PageIR to a stable JSON string with sorted object keys.
 *
 * Two replicas that observe the same logical IR must produce
 * byte-identical Yjs values; otherwise Y.Map last-writer-wins
 * semantics would flap on key-order differences alone. Sorting
 * non-array object keys here gives us that property without
 * touching the IR canonicalization in `@anvilkit/ir`.
 */
export function encodeIR(ir: PageIR): string {
	return JSON.stringify(ir, (_key, value) => sortKeysIfObject(value));
}

export function decodeIR(raw: string): PageIR {
	const parsed = JSON.parse(raw);
	if (!isObject(parsed) || parsed.version !== "1") {
		throw new Error(
			"plugin-collab-yjs: decoded payload is not a valid PageIR (missing version=1)",
		);
	}
	// Y2 — validate the structural backbone consumers dereference (the root
	// node), not just the version tag, so a corrupt legacy blob fails fast at
	// decode instead of throwing deep in projection. The IR comes from the
	// adapter's own persistence (trusted), so this is robustness, not a security
	// boundary; `assets`/`metadata` are checked only when present so older blobs
	// that omit an optional field still decode.
	const root = parsed.root;
	if (
		!isObject(root) ||
		typeof root.id !== "string" ||
		typeof root.type !== "string"
	) {
		throw new Error(
			"plugin-collab-yjs: decoded payload is not a valid PageIR (missing or malformed root node)",
		);
	}
	if (parsed.assets !== undefined && !Array.isArray(parsed.assets)) {
		throw new Error(
			"plugin-collab-yjs: decoded payload is not a valid PageIR (assets must be an array)",
		);
	}
	if (parsed.metadata !== undefined && !isObject(parsed.metadata)) {
		throw new Error(
			"plugin-collab-yjs: decoded payload is not a valid PageIR (metadata must be an object)",
		);
	}
	return parsed as unknown as PageIR;
}

/**
 * Lightweight deterministic hash for SnapshotMeta.pageIRHash.
 * Not cryptographic — just stable across replicas given the same input.
 */
export function hashIR(raw: string): string {
	let h1 = 0xdeadbeef ^ raw.length;
	let h2 = 0x41c6ce57 ^ raw.length;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const high = h2 >>> 0;
	const low = h1 >>> 0;
	return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

/**
 * P2 — stable hash of a single node's OWN content (type / slot /
 * slotKind / props / assets / meta), excluding `children` (the child
 * id list is compared exactly and cheaply by the caller). Cached per
 * node in the live-IR state so `diffIRNodesForLocalSave` classifies a
 * local save with ONE hash per next-node instead of stringifying
 * props/assets/meta of every node on BOTH sides per keystroke.
 *
 * Deliberately uses RAW `JSON.stringify` (NOT the key-sorted encoding
 * `pageIRHash` uses): it must be a faithful drop-in for the diff's
 * `JSON.stringify(n.props) !== JSON.stringify(p.props)` comparison and
 * for `reconcileProps`'s raw per-prop write decision, so the hash and
 * stringify classifications are equivalent (a prop-key reorder counts
 * as "changed" under both). It is a per-peer LOCAL change detector —
 * never compared across replicas — so insertion-order sensitivity is
 * correct here and does not affect cross-replica `pageIRHash`
 * stability. Same non-crypto {@link hashIR} collision profile the
 * codebase already relies on.
 */
export function hashNodeContent(node: PageIRNode): string {
	const own = {
		type: node.type,
		slot: node.slot,
		slotKind: node.slotKind,
		props: node.props ?? {},
		assets: node.assets ?? null,
		meta: node.meta ?? null,
	};
	return hashIR(JSON.stringify(own));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortKeysIfObject(value: unknown): unknown {
	if (!isObject(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = value[key];
	}
	return sorted;
}
