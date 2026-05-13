import { createFakePageIR } from "@anvilkit/core/testing";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { applyUpdate, Doc as YDoc, encodeStateAsUpdate } from "yjs";

import { createYjsAdapter } from "../yjs-adapter.js";

interface AwarenessInternals {
	readonly _observers: Map<string, unknown[]>;
}

interface YMapInternals {
	readonly _eH: { readonly l: unknown[] };
}

describe("createYjsAdapter destroy", () => {
	it("removes the map observer so subsequent transactions do not call subscribe listeners", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc });
		const updates: unknown[] = [];
		adapter.subscribe((ir) => updates.push(ir));

		adapter.destroy();

		const remote = new YDoc();
		const remoteAdapter = createYjsAdapter({ doc: remote });
		remoteAdapter.save(createFakePageIR({ rootId: "remote-only" }), {});
		const update = encodeStateAsUpdate(remote);
		applyUpdate(doc, update);

		expect(updates).toHaveLength(0);
	});

	it("removes the awareness churn handler so awareness changes after destroy do not increment churn", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const adapter = createYjsAdapter({ doc, awareness });

		const before = adapter.metrics().awarenessChurn;
		awareness.setLocalState({ peer: { id: "p1" } });
		const afterFirst = adapter.metrics().awarenessChurn;
		expect(afterFirst).toBeGreaterThan(before);

		adapter.destroy();

		awareness.setLocalState({ peer: { id: "p2" } });
		const afterDestroy = adapter.metrics().awarenessChurn;
		expect(afterDestroy).toBe(afterFirst);
	});

	it("releases the native-tree observer when useNativeTree was enabled", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, useNativeTree: true });
		adapter.destroy();

		const treeRoot = doc.getMap<unknown>("anvilkit-collab:tree");
		const internals = treeRoot as unknown as {
			readonly _dEH: { readonly l: unknown[] };
		};
		expect(internals._dEH.l.length).toBe(0);
	});

	it("creating and destroying 100 adapters does not accumulate awareness listeners", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const baselineListeners = (
			awareness as unknown as AwarenessInternals
		)._observers.get("change");
		const baselineLen = baselineListeners?.length ?? 0;

		for (let i = 0; i < 100; i += 1) {
			const adapter = createYjsAdapter({ doc, awareness });
			adapter.destroy();
		}

		const afterListeners = (
			awareness as unknown as AwarenessInternals
		)._observers.get("change");
		expect(afterListeners?.length ?? 0).toBe(baselineLen);
	});

	it("creating and destroying 100 adapters does not accumulate map observers", () => {
		const doc = new YDoc();
		const map = doc.getMap<string>("anvilkit-collab");
		const baselineLen = (map as unknown as YMapInternals)._eH.l.length;

		for (let i = 0; i < 100; i += 1) {
			const adapter = createYjsAdapter({ doc });
			adapter.destroy();
		}

		const afterLen = (map as unknown as YMapInternals)._eH.l.length;
		expect(afterLen).toBe(baselineLen);
	});
});
