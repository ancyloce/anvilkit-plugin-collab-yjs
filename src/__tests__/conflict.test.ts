import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import type { ConflictEvent } from "../types.js";
import { createYjsAdapter } from "../yjs-adapter.js";

function pair(a: YDoc, b: YDoc): void {
	a.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(b, u, "replicate");
	});
	b.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(a, u, "replicate");
	});
}

function withHero(props: Readonly<Record<string, unknown>>): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [{ id: "hero-1", type: "Hero", props }],
		},
	};
}

describe("createYjsAdapter onConflict", () => {
	it("fires when remote update arrives within staleAfterMs after local edit on the same node", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			staleAfterMs: 5000,
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			staleAfterMs: 5000,
		});

		const events: ConflictEvent[] = [];
		adapterA.onConflict((e) => events.push(e));

		// Alice saves an edit on Hero
		adapterA.save(withHero({ headline: "Alice writes" }), {});
		// Bob saves an overlapping edit immediately
		adapterB.save(withHero({ headline: "Bob writes" }), {});

		expect(events.length).toBeGreaterThanOrEqual(1);
		const event = events[0];
		expect(event?.kind).toBe("overlap");
		expect(event?.localPeer).toEqual({ id: "alice" });
		expect(event?.remotePeer).toEqual({ id: "bob" });
		expect(event?.nodeIds).toContain("hero-1");
	});

	it("does not fire when remote arrives outside the staleAfterMs window", () => {
		vi.useFakeTimers();
		try {
			const docA = new YDoc();
			const docB = new YDoc();
			pair(docA, docB);

			const adapterA = createYjsAdapter({
				doc: docA,
				peer: { id: "alice" },
				staleAfterMs: 100,
			});
			const adapterB = createYjsAdapter({
				doc: docB,
				peer: { id: "bob" },
				staleAfterMs: 100,
			});

			const events: ConflictEvent[] = [];
			adapterA.onConflict((e) => events.push(e));

			adapterA.save(withHero({ headline: "Alice" }), {});
			vi.advanceTimersByTime(500);
			adapterB.save(withHero({ headline: "Bob" }), {});

			expect(events).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not fire when there are no overlapping node ids", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
			staleAfterMs: 5000,
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
			staleAfterMs: 5000,
		});

		const events: ConflictEvent[] = [];
		adapterA.onConflict((e) => events.push(e));

		// Alice saves an edit; Bob saves the SAME content (no overlap)
		const ir = withHero({ headline: "Hello" });
		adapterA.save(ir, {});
		adapterB.save(ir, {});

		expect(events).toEqual([]);
	});

	it("returns an unsubscribe function", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const noop = vi.fn();
		const unsub = adapter.onConflict(noop);
		expect(typeof unsub).toBe("function");
		unsub();
	});
});
