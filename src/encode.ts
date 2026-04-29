import type { PageIR } from "@anvilkit/core/types";

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
