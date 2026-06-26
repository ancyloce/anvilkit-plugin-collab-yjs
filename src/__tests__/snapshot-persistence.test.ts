/**
 * §4.2.2 — server-grade snapshot persistence seam. The in-`Y.Doc`
 * snapshot store stays the source of truth and the default; when a host
 * supplies a `snapshotPersistence` adapter, `save()` mirrors a
 * self-contained encoded payload + meta to it, `delete()` removes it, and
 * `loadPersistedSnapshot()` hydrates a `PageIR` back through it. An
 * optional `encode`/`decode` pair is the encryption-at-rest seam and is
 * applied to the payload BEFORE/AFTER it touches the backend.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import type { SnapshotMeta } from "@anvilkit/plugin-version-history";
import { describe, expect, it, vi } from "vitest";
import { Doc as YDoc } from "yjs";

import type { SnapshotPersistenceAdapter } from "../types/types.js";
import { decodePayload, encodePayload } from "../utils/payload-chain.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

interface MemRecord {
	readonly meta: SnapshotMeta;
	readonly payload: string;
}

/**
 * Minimal in-memory {@link SnapshotPersistenceAdapter}. Records every
 * call so the test can assert what the seam actually handed the backend.
 */
function createMemAdapter() {
	const store = new Map<string, MemRecord>();
	const saveSnapshot = vi.fn((meta: SnapshotMeta, payload: string): void => {
		store.set(meta.id, { meta, payload });
	});
	const deleteSnapshot = vi.fn((id: string): void => {
		store.delete(id);
	});
	const loadSnapshot = vi.fn(
		(id: string): string | undefined => store.get(id)?.payload,
	);
	const listSnapshots = vi.fn((): readonly SnapshotMeta[] =>
		[...store.values()].map((r) => r.meta),
	);
	const adapter: SnapshotPersistenceAdapter = {
		saveSnapshot,
		loadSnapshot,
		listSnapshots,
		deleteSnapshot,
	};
	return { adapter, store, saveSnapshot, deleteSnapshot, loadSnapshot };
}

/**
 * Trivial reversible transform standing in for real encryption-at-rest.
 * The "ENC:" prefix + reversal makes the stored blob plainly not the raw
 * JSON, so "the transform was applied before persistence" is unambiguous
 * (the reversed string does not `JSON.parse`).
 */
const PREFIX = "ENC:";
const encode = (payload: string): string =>
	PREFIX + [...payload].reverse().join("");
const decode = (payload: string): string => {
	if (!payload.startsWith(PREFIX)) {
		throw new Error("missing cipher prefix");
	}
	return [...payload.slice(PREFIX.length)].reverse().join("");
};

describe("snapshot persistence seam (§4.2.2)", () => {
	it("mirrors save() to the adapter with the transformed payload + metadata", () => {
		const mem = createMemAdapter();
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			snapshotPersistence: { adapter: mem.adapter, encode, decode },
		});
		const ir = createFakePageIR();

		const id = adapter.save(ir, { label: "first" });

		// The backend received exactly one real save (not a synthetic call).
		expect(mem.saveSnapshot).toHaveBeenCalledTimes(1);
		const record = mem.store.get(id);
		expect(record).toBeDefined();

		// Metadata round-trips: the backend got the same id/label the
		// in-Y.Doc store assigned.
		expect(record?.meta.id).toBe(id);
		expect(record?.meta.label).toBe("first");
		expect(adapter.list().map((m) => m.id)).toContain(id);

		// The encryption transform was applied BEFORE persistence: the
		// stored blob is the ciphertext, not the raw payload JSON.
		const raw = encodePayload({ kind: "full", ir });
		expect(record?.payload.startsWith(PREFIX)).toBe(true);
		expect(record?.payload).not.toBe(raw);
		expect(record?.payload).toBe(encode(raw));
		// And the ciphertext is genuinely not the plaintext JSON.
		expect(() => JSON.parse(record?.payload ?? "")).toThrow();

		// Decoding the stored blob reconstructs the exact IR.
		const restored = decodePayload(decode(record?.payload ?? ""));
		expect(restored.kind).toBe("full");
		expect(restored.kind === "full" ? restored.ir : undefined).toEqual(ir);
	});

	it("round-trips load through the persistence adapter (decode applied)", async () => {
		const mem = createMemAdapter();
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			snapshotPersistence: { adapter: mem.adapter, encode, decode },
		});
		const ir = createFakePageIR({ rootId: "persisted-root" });

		const id = adapter.save(ir, { label: "persisted" });
		const hydrated = await adapter.loadPersistedSnapshot(id);

		// The hydrate went THROUGH the backend's loadSnapshot and the
		// configured decode, yielding the original IR.
		expect(mem.loadSnapshot).toHaveBeenCalledWith(id);
		expect(hydrated).toEqual(ir);
	});

	it("round-trips delete through the persistence adapter", async () => {
		const mem = createMemAdapter();
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			snapshotPersistence: { adapter: mem.adapter, encode, decode },
		});
		const ir = createFakePageIR();
		const id = adapter.save(ir, { label: "doomed" });
		expect(mem.store.has(id)).toBe(true);

		adapter.delete(id);

		expect(mem.deleteSnapshot).toHaveBeenCalledWith(id);
		expect(mem.store.has(id)).toBe(false);
		// A later hydrate resolves undefined — the backend no longer has it.
		expect(await adapter.loadPersistedSnapshot(id)).toBeUndefined();
	});

	it("works without a transform (encode/decode optional)", async () => {
		const mem = createMemAdapter();
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			snapshotPersistence: { adapter: mem.adapter },
		});
		const ir = createFakePageIR();
		const id = adapter.save(ir, {});

		// Stored verbatim (plain encoded payload, no cipher prefix).
		expect(mem.store.get(id)?.payload).toBe(
			encodePayload({ kind: "full", ir }),
		);
		expect(await adapter.loadPersistedSnapshot(id)).toEqual(ir);
	});

	it("default behavior is unchanged when no adapter is supplied", async () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const ir = createFakePageIR();
		const id = adapter.save(ir, { label: "v1" });

		// In-Y.Doc save/load is untouched.
		expect(adapter.load(id)).toEqual(ir);
		// The hydrate seam is inert without a backend.
		expect(await adapter.loadPersistedSnapshot(id)).toBeUndefined();
	});

	it("a backend fault never breaks the in-Y.Doc save (best-effort mirror)", () => {
		const onFault = vi.fn();
		const boom = new Error("backend offline");
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			snapshotPersistence: {
				adapter: {
					saveSnapshot: () => {
						throw boom;
					},
					loadSnapshot: () => undefined,
					listSnapshots: () => [],
					deleteSnapshot: () => undefined,
				},
				onFault,
			},
		});
		const ir = createFakePageIR();

		// The authoritative in-Y.Doc save still succeeds and is loadable.
		let id = "";
		expect(() => {
			id = adapter.save(ir, { label: "resilient" });
		}).not.toThrow();
		expect(adapter.load(id)).toEqual(ir);
		// The fault surfaced through onFault, not the save() call.
		expect(onFault).toHaveBeenCalledWith("saveSnapshot", boom);
	});

	it("reports an async (rejected-promise) mirror fault through onFault", async () => {
		const onFault = vi.fn();
		const boom = new Error("async backend offline");
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			snapshotPersistence: {
				adapter: {
					saveSnapshot: () => Promise.reject(boom),
					loadSnapshot: () => Promise.resolve(undefined),
					listSnapshots: () => Promise.resolve([]),
					deleteSnapshot: () => Promise.resolve(),
				},
				onFault,
			},
		});

		expect(() => adapter.save(createFakePageIR(), {})).not.toThrow();
		// Let the rejected mirror promise settle.
		await Promise.resolve();
		await Promise.resolve();
		expect(onFault).toHaveBeenCalledWith("saveSnapshot", boom);
	});

	it("does NOT mirror retention evictions to the backend (durable store keeps history)", () => {
		const mem = createMemAdapter();
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			maxSnapshots: 2,
			snapshotPersistence: { adapter: mem.adapter },
		});
		adapter.save(createFakePageIR(), { label: "v0" });
		adapter.save(createFakePageIR(), { label: "v1" });
		adapter.save(createFakePageIR(), { label: "v2" }); // evicts v0 in-Y.Doc

		// The in-Y.Doc store is capped at 2…
		expect(adapter.list()).toHaveLength(2);
		// …but the backend received all 3 saves and ZERO deletes — the
		// durable store is meant to outlive the bounded CRDT window.
		expect(mem.saveSnapshot).toHaveBeenCalledTimes(3);
		expect(mem.deleteSnapshot).not.toHaveBeenCalled();
		expect(mem.store.size).toBe(3);
	});
});
