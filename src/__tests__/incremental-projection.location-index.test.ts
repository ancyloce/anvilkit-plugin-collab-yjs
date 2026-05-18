/**
 * Review §P1/§P3 regression locks.
 *
 * §P1 — the session-held `LocationIndex` must survive across dispatches:
 * a steady-state remote-edit stream (same page structure each flush)
 * must NOT re-walk the document. We observe this via Map identity —
 * `resolve` returns the very same Map object until the cheap
 * O(top-level) structure fingerprint changes or `invalidate()` is
 * called (both of which force exactly one rebuild).
 *
 * §P3 — a single-content edit on a multi-zone page must leave the
 * untouched zone arrays at their original object identity so the
 * downstream replace planner free-skips them.
 */

import type { PageIR } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import { describe, expect, it } from "vitest";

import {
	type ProjectionData,
	createLocationIndex,
	projectChangedNodes,
} from "../incremental-projection.js";

function ir(children: PageIR["root"]["children"]): PageIR {
	return {
		version: 1,
		root: { id: "root", type: "Root", props: {}, children },
	} as unknown as PageIR;
}
const asData = (r: PageIR): ProjectionData =>
	irToPuckData(r) as unknown as ProjectionData;

describe("createLocationIndex — carried across dispatches (§P1)", () => {
	it("reuses the same index Map while top-level structure is stable", () => {
		const idx = createLocationIndex();
		const d1 = asData(
			ir([
				{ id: "a", type: "Hero", props: { t: "0" } },
				{ id: "b", type: "Hero", props: { t: "0" } },
			]),
		);
		const first = idx.resolve(d1);
		// A *different* Data object (Puck rematerialises every dispatch)
		// with the same top-level id sequence must NOT trigger a rewalk.
		const d2 = asData(
			ir([
				{ id: "a", type: "Hero", props: { t: "1" } },
				{ id: "b", type: "Hero", props: { t: "2" } },
			]),
		);
		expect(idx.resolve(d2)).toBe(first);
	});

	it("rebuilds when the top-level id sequence changes", () => {
		const idx = createLocationIndex();
		const first = idx.resolve(
			asData(ir([{ id: "a", type: "Hero", props: {} }])),
		);
		const second = idx.resolve(
			asData(
				ir([
					{ id: "a", type: "Hero", props: {} },
					{ id: "c", type: "Hero", props: {} },
				]),
			),
		);
		expect(second).not.toBe(first);
		expect(second.has("c")).toBe(true);
	});

	it("rebuilds after invalidate()", () => {
		const idx = createLocationIndex();
		const d = asData(ir([{ id: "a", type: "Hero", props: {} }]));
		const first = idx.resolve(d);
		expect(idx.resolve(d)).toBe(first);
		idx.invalidate();
		expect(idx.resolve(d)).not.toBe(first);
	});

	it("an unknown changed id invalidates the carried index", () => {
		const idx = createLocationIndex();
		const before = asData(ir([{ id: "a", type: "Hero", props: { t: "0" } }]));
		const seeded = idx.resolve(before);
		// Drive the projection with an id not present → structural bail.
		expect(
			projectChangedNodes(before, ir([]), new Set(["ghost"]), idx),
		).toBeNull();
		// Next resolve must reseed (different Map) rather than reuse stale.
		expect(idx.resolve(before)).not.toBe(seeded);
	});
});

describe("projectChangedNodes — selective array cloning (§P3)", () => {
	it("a content-only edit leaves untouched zone arrays at original identity", () => {
		const before = asData(
			ir([{ id: "a", type: "Hero", props: { t: "a0" } }]),
		) as ProjectionData & {
			zones?: Record<string, unknown[]>;
		};
		// Hand-attach two zones (irToPuckData on flat content yields none).
		(before as { zones: Record<string, unknown[]> }).zones = {
			"z-1": [{ type: "Hero", props: { id: "z1" } }],
			"z-2": [{ type: "Hero", props: { id: "z2" } }],
		};
		const newIR = ir([{ id: "a", type: "Hero", props: { t: "a1" } }]);
		const out = projectChangedNodes(before, newIR, new Set(["a"])) as
			| (ProjectionData & { zones?: Record<string, unknown[]> })
			| null;
		expect(out).not.toBeNull();
		// Content array was cloned + item rebuilt …
		expect(out?.content).not.toBe(before.content);
		// … but the untouched zone arrays keep their original identity.
		expect(out?.zones?.["z-1"]).toBe(before.zones?.["z-1"]);
		expect(out?.zones?.["z-2"]).toBe(before.zones?.["z-2"]);
	});
});
