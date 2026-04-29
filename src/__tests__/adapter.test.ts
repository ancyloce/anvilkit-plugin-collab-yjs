import { createFakePageIR } from "@anvilkit/core/testing";
import type { PresenceState } from "@anvilkit/plugin-version-history";
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { applyUpdate, Doc as YDoc } from "yjs";

import { createYjsAdapter } from "../yjs-adapter.js";

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
		const stop = adapterB.subscribe?.((ir) => updates.push(ir));
		expect(typeof stop).toBe("function");

		adapterA.save(createFakePageIR(), {});
		expect(updates).toHaveLength(1);

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

	it("load throws when the requested snapshot id is not in the index", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		expect(() => adapter.load("missing")).toThrow(/no snapshot/i);
	});
});
