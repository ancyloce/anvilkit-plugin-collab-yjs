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

function withHero(text: string): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [{ id: "hero-1", type: "Hero", props: { text } }],
		},
	};
}

describe("createYjsAdapter conflict window (M2)", () => {
	it("fires a conflict even after a burst of local saves keeps lastLocalSavedAt fresh", () => {
		vi.useFakeTimers();
		try {
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

			// Alice fires 49 rapid saves (every 100ms) — under the OLD
			// implementation, this kept `lastLocalSavedAt` glued to the
			// "now" cursor, so the conflict-detection window (measured
			// from lastLocalSavedAt) would suppress a conflict if Bob's
			// edit landed even 4900ms after Alice's FIRST save. The fix
			// measures from firstUnconfirmedLocalSaveAt instead.
			for (let i = 0; i < 49; i += 1) {
				adapterA.save(withHero(`alice-${i}`), {});
				vi.advanceTimersByTime(100);
			}
			// t = 4900ms; Bob lands a concurrent edit on the same node.
			adapterB.save(withHero("bob-overlap"), {});

			expect(events.length).toBeGreaterThanOrEqual(1);
			expect(events[0]?.nodeIds).toContain("hero-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT fire when remote arrives past staleAfterMs since the FIRST local save", () => {
		vi.useFakeTimers();
		try {
			const docA = new YDoc();
			const docB = new YDoc();
			pair(docA, docB);

			const adapterA = createYjsAdapter({
				doc: docA,
				peer: { id: "alice" },
				staleAfterMs: 1000,
			});
			const adapterB = createYjsAdapter({
				doc: docB,
				peer: { id: "bob" },
				staleAfterMs: 1000,
			});
			const events: ConflictEvent[] = [];
			adapterA.onConflict((e) => events.push(e));

			adapterA.save(withHero("alice-first"), {});
			vi.advanceTimersByTime(2000); // past staleAfterMs
			adapterB.save(withHero("bob-late"), {});

			expect(events).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
