import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import { encodeIR } from "../utils/encode.js";
import {
	buildDeltaPayload,
	decodePayload,
	encodePayload,
	type PayloadBackend,
	reconstructPayload,
	type StoredPayload,
} from "../utils/payload-chain.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

function leaf(id: string, props: Record<string, unknown> = {}): PageIRNode {
	return { id, type: "Block", props };
}

function page(children: PageIRNode[]): PageIR {
	return {
		version: "1",
		root: { id: "root", type: "Root", props: {}, children },
		assets: [],
		metadata: {},
	};
}

/** Replace one child's prop; structural-sharing clone like the harness. */
function editChild(ir: PageIR, idx: number, counter: number): PageIR {
	const children = (ir.root.children ?? []).slice();
	const old = children[idx];
	if (old) children[idx] = { ...old, props: { ...old.props, v: counter } };
	return { ...ir, root: { ...ir.root, children } };
}

describe("payload-chain (module)", () => {
	it("round-trips a full keyframe payload through encode/decode", () => {
		const ir = page([leaf("a"), leaf("b")]);
		const decoded = decodePayload(encodePayload({ kind: "full", ir }));
		expect(decoded).toEqual({ kind: "full", ir });
	});

	it("reads a legacy raw-encoded-IR payload as a keyframe", () => {
		const ir = page([leaf("a")]);
		// Pre-delta-chain payloads were the raw `encodeIR(ir)` string.
		const decoded = decodePayload(encodeIR(ir));
		expect(decoded.kind).toBe("full");
		expect(decoded.kind === "full" && decoded.ir).toEqual(ir);
	});

	it("reconstructs a delta against a keyframe by node id", () => {
		const base = page([leaf("a", { v: 0 }), leaf("b", { v: 0 })]);
		const next = editChild(base, 1, 7); // b.props.v = 7
		const records = new Map<string, StoredPayload>([
			["k0", { kind: "full", ir: base }],
		]);
		records.set(
			"d1",
			buildDeltaPayload({
				base: "k0",
				ir: next,
				changed: new Map([["b", next.root.children?.[1] as PageIRNode]]),
				removed: new Set(),
			}),
		);
		const backend: PayloadBackend = {
			read: (id) => records.get(id),
			write: (id, p) => records.set(id, p),
			orderedIds: () => [...records.keys()],
		};
		expect(reconstructPayload(backend, "d1")).toEqual(next);
	});

	it("throws on a chain that references a missing base", () => {
		const records = new Map<string, StoredPayload>([
			[
				"d1",
				{
					kind: "delta",
					base: "gone",
					changed: [],
					removed: [],
					assets: [],
					metadata: {},
				},
			],
		]);
		const backend: PayloadBackend = {
			read: (id) => records.get(id),
			write: (id, p) => records.set(id, p),
			orderedIds: () => [...records.keys()],
		};
		expect(() => reconstructPayload(backend, "d1")).toThrow(/missing record/);
	});
});

describe("payload-chain (adapter integration)", () => {
	const PAYLOAD_PREFIX = "snapshotPayload:";

	function payloadKind(doc: YDoc, id: string): string {
		const raw = doc
			.getMap<string>("anvilkit-collab")
			.get(`${PAYLOAD_PREFIX}${id}`);
		return JSON.parse(raw as string).kind;
	}

	it("stores deltas between keyframes and load() reconstructs every save", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc });
		const base = page(
			Array.from({ length: 8 }, (_, i) => leaf(`n-${i}`, { v: 0 })),
		);

		const ids: string[] = [];
		const expected: PageIR[] = [];
		let current = base;
		// 25 saves > KEYFRAME_INTERVAL (20) → at least one re-keyframe.
		for (let i = 0; i < 25; i += 1) {
			current = i === 0 ? base : editChild(current, i % 8, i);
			ids.push(adapter.save(current, {}));
			expected.push(current);
		}

		// First save is a keyframe; an early non-keyframe save is a delta.
		expect(payloadKind(doc, ids[0]!)).toBe("full");
		expect(payloadKind(doc, ids[3]!)).toBe("delta");

		// Every snapshot reconstructs byte-for-byte, across keyframe spans.
		for (let i = 0; i < ids.length; i += 1) {
			expect(adapter.load(ids[i]!)).toEqual(expected[i]);
		}
		adapter.destroy();
	});

	it("a delta payload is much smaller than a full keyframe", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc });
		const base = page(
			Array.from({ length: 200 }, (_, i) => leaf(`n-${i}`, { v: 0 })),
		);
		const k0 = adapter.save(base, {});
		const d1 = adapter.save(editChild(base, 5, 1), {});

		const map = doc.getMap<string>("anvilkit-collab");
		const fullBytes = (map.get(`${PAYLOAD_PREFIX}${k0}`) as string).length;
		const deltaBytes = (map.get(`${PAYLOAD_PREFIX}${d1}`) as string).length;
		// A single-node change stores one node, not all 200.
		expect(deltaBytes).toBeLessThan(fullBytes / 10);
		adapter.destroy();
	});

	it("re-roots a surviving delta when its base keyframe is evicted", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, maxSnapshots: 3 });
		const base = page([leaf("a", { v: 0 }), leaf("b", { v: 0 })]);

		let current = base;
		const ids: string[] = [];
		const expected: PageIR[] = [];
		for (let i = 0; i < 6; i += 1) {
			current = i === 0 ? base : editChild(current, 0, i);
			ids.push(adapter.save(current, {}));
			expected.push(current);
		}

		// Only the last 3 are retained; older ones (incl. the first
		// keyframe) were evicted — yet the survivors still reconstruct.
		const retained = adapter.list();
		expect(retained).toHaveLength(3);
		for (const meta of retained) {
			const idx = ids.indexOf(meta.id);
			expect(adapter.load(meta.id)).toEqual(expected[idx]);
		}
		adapter.destroy();
	});
});
