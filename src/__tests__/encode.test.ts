/**
 * Module-level unit tests for `encode.ts` — round-trip equivalence,
 * sorted-key determinism across replicas, and `hashIR` stability.
 *
 * `round-trip.test.ts` already covers a CRDT-paired adapter scenario;
 * this file pins the deterministic-encoding contract that the rest of
 * the plugin depends on (PRD §6.1).
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";

import { decodeIR, encodeIR, hashIR } from "../encode.js";

describe("encodeIR", () => {
	it("round-trips a PageIR losslessly", () => {
		const ir = createFakePageIR();
		expect(decodeIR(encodeIR(ir))).toEqual(ir);
	});

	it("sorts non-array object keys deterministically", () => {
		const a: PageIR = {
			version: "1",
			root: {
				id: "root",
				type: "__root__",
				props: { z: 1, a: 2, m: 3 },
			},
			assets: [],
			metadata: { createdAt: new Date(0).toISOString() },
		};
		const b: PageIR = {
			version: "1",
			metadata: { createdAt: new Date(0).toISOString() },
			assets: [],
			root: { props: { m: 3, a: 2, z: 1 }, type: "__root__", id: "root" },
		};
		expect(encodeIR(a)).toBe(encodeIR(b));
	});

	it("preserves array element order (arrays are not sorted)", () => {
		const children: PageIRNode[] = [
			{ id: "a", type: "Hero", props: { headline: "a" } },
			{ id: "b", type: "Hero", props: { headline: "b" } },
			{ id: "c", type: "Hero", props: { headline: "c" } },
		];
		const ir = createFakePageIR({ children });
		const encoded = encodeIR(ir);
		const idsInOrder = ["a", "b", "c"].map((id) => encoded.indexOf(`"${id}"`));
		// Each id appears, and the indices are strictly ascending.
		expect(idsInOrder.every((idx) => idx >= 0)).toBe(true);
		expect(idsInOrder).toEqual([...idsInOrder].sort((x, y) => x - y));
	});

	it("produces sorted keys for nested object props recursively", () => {
		const ir: PageIR = {
			version: "1",
			root: {
				id: "root",
				type: "__root__",
				props: {
					nested: { z: { y: 1, x: 2 }, a: 9 },
				},
			},
			assets: [],
			metadata: {},
		};
		const encoded = encodeIR(ir);
		// "a" before "z" at the inner level, "x" before "y" at the leaf.
		expect(encoded.indexOf('"a":')).toBeLessThan(encoded.indexOf('"z":'));
		expect(encoded.indexOf('"x":')).toBeLessThan(encoded.indexOf('"y":'));
	});
});

describe("decodeIR", () => {
	it("rejects payloads missing the version=1 marker", () => {
		expect(() => decodeIR(JSON.stringify({ root: {} }))).toThrow(/version=1/);
	});

	it("rejects non-object JSON payloads", () => {
		expect(() => decodeIR(JSON.stringify([1, 2, 3]))).toThrow(/version=1/);
		expect(() => decodeIR(JSON.stringify("string"))).toThrow(/version=1/);
		expect(() => decodeIR(JSON.stringify(null))).toThrow(/version=1/);
	});

	it("propagates SyntaxError for non-JSON input", () => {
		expect(() => decodeIR("{not-json")).toThrow();
	});
});

describe("hashIR", () => {
	it("is deterministic for identical input strings", () => {
		const ir = createFakePageIR();
		const a = hashIR(encodeIR(ir));
		const b = hashIR(encodeIR(ir));
		expect(a).toBe(b);
	});

	it("is stable across replicas authoring equivalent (key-reordered) IRs", () => {
		const a: PageIR = {
			version: "1",
			root: { id: "r", type: "__root__", props: { a: 1, b: 2 } },
			assets: [],
			metadata: { createdAt: new Date(0).toISOString() },
		};
		const b: PageIR = {
			version: "1",
			metadata: { createdAt: new Date(0).toISOString() },
			assets: [],
			root: { props: { b: 2, a: 1 }, type: "__root__", id: "r" },
		};
		// Replicas authoring equivalent IR must agree on the snapshot
		// hash — otherwise SnapshotMeta.pageIRHash flaps on key-order
		// alone and version-history diffs misreport identical content.
		expect(hashIR(encodeIR(a))).toBe(hashIR(encodeIR(b)));
	});

	it("differs when the underlying string differs by one character", () => {
		expect(hashIR("anvilkit-collab")).not.toBe(hashIR("Anvilkit-collab"));
	});

	it("returns a 16-character lowercase hex string", () => {
		const h = hashIR(encodeIR(createFakePageIR()));
		expect(h).toMatch(/^[0-9a-f]{16}$/);
	});

	it("handles empty input without throwing", () => {
		expect(() => hashIR("")).not.toThrow();
		expect(hashIR("")).toMatch(/^[0-9a-f]{16}$/);
	});
});
