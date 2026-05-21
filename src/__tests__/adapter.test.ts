import { createFakePageIR } from "@anvilkit/core/testing";
import type { PresenceState } from "@anvilkit/plugin-version-history";
import { runAdapterContract } from "@anvilkit/plugin-version-history/testing";
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { applyUpdate, Doc as YDoc } from "yjs";

import { createYjsAdapter } from "../yjs-adapter.js";

runAdapterContract(() => createYjsAdapter({ doc: new YDoc() }), {
	describe,
	expect,
	it,
});

describe("createYjsAdapter", () => {
	it("save and load round-trip a single PageIR", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const ir = createFakePageIR();
		const id = adapter.save(ir, { label: "first" });
		expect(adapter.load(id)).toEqual(ir);
	});

	it("list returns the most recent snapshot meta", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const ir = createFakePageIR();
		adapter.save(ir, { label: "v1" });
		const list = adapter.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.label).toBe("v1");
		expect(typeof list[0]?.pageIRHash).toBe("string");
	});

	it("preserves multiple snapshots and loads each id independently", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const first = createFakePageIR({
			rootId: "first-root",
			metadata: { createdAt: new Date(0).toISOString() },
		});
		const second = createFakePageIR({
			rootId: "second-root",
			metadata: { createdAt: new Date(1).toISOString() },
		});

		const firstId = adapter.save(first, { label: "first" });
		const secondId = adapter.save(second, { label: "second" });

		expect(adapter.list().map((meta) => meta.id)).toEqual([firstId, secondId]);
		expect(adapter.load(firstId)).toEqual(first);
		expect(adapter.load(secondId)).toEqual(second);
	});

	it("delete removes snapshot metadata and payload", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const firstId = adapter.save(createFakePageIR({ rootId: "first" }), {});
		const secondId = adapter.save(createFakePageIR({ rootId: "second" }), {});

		adapter.delete?.(firstId);

		expect(adapter.list().map((meta) => meta.id)).toEqual([secondId]);
		expect(() => adapter.load(firstId)).toThrow(/no snapshot/i);
	});

	it("subscribe fires on remote changes only (not local writes)", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		docA.on("update", (u, o) => {
			if (o !== "replicate") applyUpdate(docB, u, "replicate");
		});
		docB.on("update", (u, o) => {
			if (o !== "replicate") applyUpdate(docA, u, "replicate");
		});

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const updates: unknown[] = [];
		const peers: unknown[] = [];
		const stop = adapterB.subscribe?.((ir, peer) => {
			updates.push(ir);
			peers.push(peer);
		});
		expect(typeof stop).toBe("function");

		adapterA.save(createFakePageIR(), {});
		expect(updates).toHaveLength(1);
		expect(peers).toContainEqual({ id: "alice" });

		// Local write on B does NOT trigger B's subscriber.
		adapterB.save(createFakePageIR(), {});
		expect(updates).toHaveLength(1);

		stop?.();
	});

	it("presence broadcasts via y-protocols Awareness", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const adapter = createYjsAdapter({
			doc,
			awareness,
			peer: { id: "alice" },
		});
		const callback = vi.fn();
		adapter.presence?.onPeerChange(callback);

		const state: PresenceState = {
			peer: { id: "alice", color: "#f43f5e" },
			cursor: { x: 12, y: 34 },
		};
		adapter.presence?.update(state);

		expect(callback).toHaveBeenCalled();
		const lastCall = callback.mock.calls.at(-1)?.[0] as PresenceState[];
		expect(lastCall).toContainEqual(state);
	});

	it("presence subscribers receive the current awareness state immediately", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const adapter = createYjsAdapter({
			doc,
			awareness,
			peer: { id: "alice" },
		});
		const state: PresenceState = {
			peer: { id: "alice", color: "#f43f5e" },
			cursor: { x: 12, y: 34 },
		};
		adapter.presence?.update(state);

		const callback = vi.fn();
		adapter.presence?.onPeerChange(callback);

		expect(callback).toHaveBeenCalledWith([state]);
	});

	it("load throws when the requested snapshot id is not in the index", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		expect(() => adapter.load("missing")).toThrow(/no snapshot/i);
	});

	it("treats corrupt legacy snapshot indexes as empty instead of throwing raw parse errors", () => {
		const doc = new YDoc();
		doc.getMap<string>("anvilkit-collab").set("snapshotIndex", "{");
		const adapter = createYjsAdapter({ doc });

		expect(adapter.list()).toEqual([]);
		expect(() => adapter.load("missing")).toThrow(/no snapshot/i);
	});
});
