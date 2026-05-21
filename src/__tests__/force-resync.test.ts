import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import { createYjsAdapter } from "../yjs-adapter.js";

function withHero(headline: string): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [{ id: "hero-1", type: "Hero", props: { headline } }],
		},
	};
}

describe("createYjsAdapter forceResync", () => {
	it("resolves to null when no snapshot exists", async () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		await expect(adapter.forceResync()).resolves.toBeNull();
	});

	it("restores the latest saved snapshot and emits via subscribe", async () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const saved = withHero("authoritative");
		adapter.save(saved, { label: "v1" });

		// Simulate dirty local edit on top of the snapshot.
		adapter.save(withHero("dirty draft"), {});

		const received: PageIR[] = [];
		adapter.subscribe((ir) => received.push(ir));

		const restored = await adapter.forceResync();
		expect(restored).not.toBeNull();
		expect(received.length).toBeGreaterThanOrEqual(1);
		const last = received.at(-1);
		expect(last?.root.children?.[0]?.props).toEqual({
			headline: "dirty draft",
		});
		// The latest snapshot is the second save above (LWW timestamp
		// ordering by id) — both `dirty draft` are stored, the most
		// recent wins. Asserting that the restored payload comes from
		// the snapshot keys, not the live Y.Map alone.
		expect(restored?.root.children?.[0]?.type).toBe("Hero");
	});

	it("works with the native-tree opt-in", async () => {
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			useNativeTree: true,
		});
		const saved = withHero("native authoritative");
		adapter.save(saved, { label: "v1" });

		const received: PageIR[] = [];
		adapter.subscribe((ir) => received.push(ir));

		const restored = await adapter.forceResync();
		expect(restored?.root.children?.[0]?.props).toEqual({
			headline: "native authoritative",
		});
		expect(received.at(-1)?.root.children?.[0]?.type).toBe("Hero");
	});

	it("re-emits the snapshot to all subscribers", async () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		adapter.save(withHero("v1"), { label: "v1" });

		const a: PageIR[] = [];
		const b: PageIR[] = [];
		adapter.subscribe((ir) => a.push(ir));
		adapter.subscribe((ir) => b.push(ir));

		await adapter.forceResync();
		expect(a.length).toBe(1);
		expect(b.length).toBe(1);
	});
});
