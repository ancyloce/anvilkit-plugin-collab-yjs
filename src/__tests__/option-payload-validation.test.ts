/**
 * Report 0006 §4.2.4 — option & payload/meta validation hardening.
 *
 * Two trust boundaries are exercised here:
 *
 * 1. Adapter construction (`createYjsAdapter`) — a blank `mapName` or an
 *    id-less local peer must fail fast with a typed
 *    {@link InvalidAdapterOptionsError} instead of silently binding to
 *    the wrong shared `Y.Map` / attributing writes to a nameless peer.
 * 2. Payload & metadata decode — a malformed delta payload op, an
 *    unsupported payload version, an invalid snapshot-meta timestamp, an
 *    empty snapshot id, or a malformed delta operation in the meta must
 *    surface as the typed {@link SnapshotCorruptedError} (corruption),
 *    not be replayed as silently-malformed data or mis-reported as a
 *    plain miss.
 *
 * Well-formed inputs must keep decoding/constructing unchanged.
 */

import type { PageIR } from "@anvilkit/core/types";
import type { SnapshotMeta } from "@anvilkit/plugin-version-history";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import type { SnapshotPersistenceAdapter } from "../types/types.js";
import { InvalidAdapterOptionsError } from "../utils/adapter-errors.js";
import { snapshotMetaKey, snapshotPayloadKey } from "../utils/keys.js";
import {
	buildDeltaPayload,
	decodePayload,
	encodePayload,
} from "../utils/payload-chain.js";
import {
	SnapshotCorruptedError,
	SnapshotNotFoundError,
} from "../utils/snapshot-errors.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

const MAP = "anvilkit-collab";

function validIR(): PageIR {
	return {
		version: "1",
		root: {
			id: "root",
			type: "Root",
			props: {},
			children: [{ id: "a", type: "Block", props: { v: 1 } }],
		},
		assets: [],
		metadata: {},
	};
}

function validMeta(id: string, extra: Partial<SnapshotMeta> = {}): string {
	return JSON.stringify({
		id,
		savedAt: new Date().toISOString(),
		pageIRHash: "hash",
		...extra,
	});
}

describe("§4.2.4 createYjsAdapter option validation", () => {
	it("rejects an empty mapName with a typed InvalidAdapterOptionsError", () => {
		expect(() => createYjsAdapter({ doc: new YDoc(), mapName: "" })).toThrow(
			InvalidAdapterOptionsError,
		);
	});

	it("rejects a blank (whitespace-only) mapName", () => {
		try {
			createYjsAdapter({ doc: new YDoc(), mapName: "   " });
			throw new Error("expected createYjsAdapter to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidAdapterOptionsError);
			expect((error as InvalidAdapterOptionsError).option).toBe("mapName");
		}
	});

	it("rejects a non-string mapName supplied by a JS caller", () => {
		expect(() =>
			createYjsAdapter({
				doc: new YDoc(),
				// @ts-expect-error — exercising the runtime guard for JS callers.
				mapName: 42,
			}),
		).toThrow(InvalidAdapterOptionsError);
	});

	it("rejects a local peer with an empty id", () => {
		try {
			createYjsAdapter({ doc: new YDoc(), peer: { id: "" } });
			throw new Error("expected createYjsAdapter to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidAdapterOptionsError);
			expect((error as InvalidAdapterOptionsError).option).toBe("peer.id");
		}
	});

	it("rejects a local peer with a blank id", () => {
		expect(() =>
			createYjsAdapter({ doc: new YDoc(), peer: { id: "  " } }),
		).toThrow(InvalidAdapterOptionsError);
	});

	it("keeps constructing for well-formed options", () => {
		expect(() => createYjsAdapter({ doc: new YDoc() })).not.toThrow();
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			mapName: "room",
			peer: { id: "alice" },
		});
		const ir = validIR();
		const id = adapter.save(ir, {});
		expect(adapter.load(id)).toEqual(ir);
		adapter.destroy();
	});
});

describe("§4.2.4 payload decode validation", () => {
	it("decodes a well-formed full keyframe and delta payload unchanged", () => {
		const ir = validIR();
		expect(decodePayload(encodePayload({ kind: "full", ir }))).toEqual({
			kind: "full",
			ir,
		});
		const delta = buildDeltaPayload({
			base: "base-id",
			ir,
			changed: new Map([["a", ir.root.children?.[0] as PageIR["root"]]]),
			removed: new Set<string>(),
		});
		expect(decodePayload(encodePayload(delta))).toEqual(delta);
	});

	it("load() reports a delta payload with a malformed changed node as corruption", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc });
		const baseId = adapter.save(validIR(), {});

		const map = doc.getMap<string>(MAP);
		// A delta whose `changed` entry is not a valid stored node (numeric
		// id). The base keyframe exists & is valid, so reconstruction would
		// otherwise SUCCEED (the orphan node is silently dropped) — exactly
		// the "proceed with malformed data" the hardening must prevent.
		map.set(snapshotMetaKey("bad-delta"), validMeta("bad-delta"));
		map.set(
			snapshotPayloadKey("bad-delta"),
			JSON.stringify({
				kind: "delta",
				base: baseId,
				changed: [{ id: 123, type: "Block", props: {} }],
				removed: [],
				assets: [],
				metadata: {},
			}),
		);

		expect(() => adapter.load("bad-delta")).toThrow(SnapshotCorruptedError);
		adapter.destroy();
	});

	it("loadPersistedSnapshot() reports an unsupported payload version as corruption", async () => {
		const badVersionPayload = JSON.stringify({
			kind: "full",
			ir: { version: "2", root: { id: "r", type: "R", props: {} } },
		});
		const backend: SnapshotPersistenceAdapter = {
			saveSnapshot: () => undefined,
			loadSnapshot: (id) => (id === "bad" ? badVersionPayload : undefined),
			listSnapshots: () => [],
			deleteSnapshot: () => undefined,
		};
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			snapshotPersistence: { adapter: backend },
		});
		await expect(adapter.loadPersistedSnapshot("bad")).rejects.toThrow(
			SnapshotCorruptedError,
		);
		adapter.destroy();
	});
});

describe("§4.2.4 snapshot metadata decode validation", () => {
	function seedMetaOnly(
		id: string,
		rawMeta: string,
	): {
		adapter: ReturnType<typeof createYjsAdapter>;
		doc: YDoc;
	} {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc });
		const map = doc.getMap<string>(MAP);
		map.set(snapshotMetaKey(id), rawMeta);
		// Valid payload so the ONLY defect is in the metadata — without this
		// the legacy "payload missing" path would already flag corruption
		// and mask whether the meta validation fired.
		map.set(
			snapshotPayloadKey(id),
			encodePayload({ kind: "full", ir: validIR() }),
		);
		return { adapter, doc };
	}

	it("reports an empty snapshot id as corruption (not a miss)", () => {
		const { adapter } = seedMetaOnly("empty-id", validMeta("", {}));
		try {
			adapter.load("empty-id");
			throw new Error("expected load() to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SnapshotCorruptedError);
			expect(error).not.toBeInstanceOf(SnapshotNotFoundError);
		}
		adapter.destroy();
	});

	it("reports a non-finite/invalid savedAt timestamp as corruption", () => {
		const { adapter } = seedMetaOnly(
			"bad-ts",
			JSON.stringify({ id: "bad-ts", savedAt: "not-a-date", pageIRHash: "h" }),
		);
		expect(() => adapter.load("bad-ts")).toThrow(SnapshotCorruptedError);
		adapter.destroy();
	});

	it("reports a malformed delta operation in the meta as corruption", () => {
		const { adapter } = seedMetaOnly(
			"bad-op",
			validMeta("bad-op", {
				// @ts-expect-error — deliberately invalid IRDiffOp.
				delta: [{ kind: "totally-bogus" }],
			}),
		);
		expect(() => adapter.load("bad-op")).toThrow(SnapshotCorruptedError);
		adapter.destroy();
	});

	it("still loads a snapshot whose meta carries a well-formed delta", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, computeDelta: true });
		const ir = validIR();
		const id = adapter.save(ir, {});
		expect(adapter.load(id)).toEqual(ir);
		// Meta with a real, valid change-prop op decodes without throwing.
		const map = doc.getMap<string>(MAP);
		map.set(
			snapshotMetaKey(id),
			validMeta(id, {
				delta: [
					{
						kind: "change-prop",
						path: "/root/children/0/props",
						key: "v",
						before: 1,
						after: 2,
					},
				],
			}),
		);
		expect(adapter.load(id)).toEqual(ir);
		adapter.destroy();
	});
});
