/**
 * P1 follow-up — O(changed) remote-apply fast path.
 *
 * The adapter already computes `{ ids, structural }` for every inbound
 * remote edit (`deriveChangedNodeIds`). This suite asserts that set is
 * now threaded all the way through `subscribe` → inbound scheduler →
 * `dispatchRemoteIR`, that a non-structural single-node edit still
 * produces exactly one atomic `replace` (output unchanged — the fast
 * path only narrows *which props are compared*, never the dispatch),
 * that the scheduler unions changed ids across coalesced updates and
 * poisons to `undefined` on any unknown-scope entry, and that the
 * legacy no-`changed` path still takes the full O(document) diff.
 */

import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { PageIR, StudioPluginContext } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import { createInboundScheduler } from "../utils/inbound-scheduler.js";
import { createCollabDataPlugin as baseCollabPlugin } from "../plugin.js";
import type {
	CreateCollabPluginOptions,
	RemoteChange,
} from "../types/types.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";
import {
	manualInboundScheduler,
	syncInboundScheduler,
} from "./helpers/inbound.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

const createCollabDataPlugin = (o: CreateCollabPluginOptions) =>
	baseCollabPlugin({
		...o,
		inboundScheduler: o.inboundScheduler ?? syncInboundScheduler(),
	});

/** Build an IR with `n` Hero nodes (`hero-0..hero-(n-1)`). */
function multiHero(
	labels: ReadonlyArray<string>,
	extra?: { readonly id: string; readonly text: string },
): PageIR {
	const ir = createFakePageIR();
	const children = labels.map((text, i) => ({
		id: `hero-${i}`,
		type: "Hero",
		props: { text },
	}));
	if (extra) {
		children.push({ id: extra.id, type: "Hero", props: { text: extra.text } });
	}
	return { ...ir, root: { ...ir.root, children } };
}

function ir(rootId: string): PageIR {
	return {
		version: "1",
		root: { id: rootId, type: "Root", props: {} },
		assets: [],
		metadata: {},
	} as PageIR;
}

describe("inbound scheduler carries + merges RemoteChange", () => {
	it("unions changed ids and ORs structural across a coalesced burst", () => {
		const flush = vi.fn();
		const manual = manualInboundScheduler();
		const s = createInboundScheduler({ flush, scheduler: manual.scheduler });

		s.enqueue(
			"r",
			ir("a"),
			{ id: "p" },
			{ ids: new Set(["n1"]), structural: false },
		);
		s.enqueue(
			"r",
			ir("b"),
			{ id: "p" },
			{ ids: new Set(["n2"]), structural: false },
		);
		s.enqueue(
			"r",
			ir("c"),
			{ id: "p" },
			{ ids: new Set(["n3"]), structural: true },
		);

		manual.flush();
		expect(flush).toHaveBeenCalledTimes(1);
		const changed = flush.mock.calls[0]![4] as RemoteChange;
		expect([...changed.ids].sort()).toEqual(["n1", "n2", "n3"]);
		expect(changed.structural).toBe(true);
	});

	it("poisons the merged change to undefined when any coalesced entry is unknown-scope", () => {
		const flush = vi.fn();
		const manual = manualInboundScheduler();
		const s = createInboundScheduler({ flush, scheduler: manual.scheduler });

		s.enqueue(
			"r",
			ir("a"),
			{ id: "p" },
			{ ids: new Set(["n1"]), structural: false },
		);
		s.enqueue("r", ir("b"), { id: "p" }, undefined);

		manual.flush();
		expect(flush.mock.calls[0]![4]).toBeUndefined();
	});

	it("forwards a single update's change descriptor untouched", () => {
		const flush = vi.fn();
		const manual = manualInboundScheduler();
		const s = createInboundScheduler({ flush, scheduler: manual.scheduler });
		s.enqueue("r", ir("a"), undefined, {
			ids: new Set(["x"]),
			structural: false,
		});
		manual.flush();
		const changed = flush.mock.calls[0]![4] as RemoteChange;
		expect([...changed.ids]).toEqual(["x"]);
		expect(changed.structural).toBe(false);
	});
});

describe("real adapter threads { ids, structural } through subscribe", () => {
	function pairDocs(): { docA: YDoc; docB: YDoc } {
		const docA = new YDoc();
		const docB = new YDoc();
		docA.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== "replicate") applyUpdate(docB, u, "replicate");
		});
		docB.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== "replicate") applyUpdate(docA, u, "replicate");
		});
		return { docA, docB };
	}

	it("reports the single touched node id and structural=false for a prop-only edit", () => {
		const { docA, docB } = pairDocs();
		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const seen: Array<RemoteChange | undefined> = [];
		adapterA.subscribe((_ir, _peer, changed) => seen.push(changed));

		adapterB.save(multiHero(["a", "b", "c"]), {}); // seed (structural)
		adapterB.save(multiHero(["a", "B!", "c"]), {}); // hero-1 prop edit

		const last = seen.at(-1);
		expect(last).toBeDefined();
		expect(last?.structural).toBe(false);
		expect([...(last as RemoteChange).ids]).toEqual(["hero-1"]);
	});

	it("P1 — a node add is a non-structural relink (not a full rebuild)", () => {
		const { docA, docB } = pairDocs();
		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const seen: Array<RemoteChange | undefined> = [];
		adapterA.subscribe((_ir, _peer, changed) => seen.push(changed));

		adapterB.save(multiHero(["a", "b"]), {});
		adapterB.save(multiHero(["a", "b"], { id: "hero-new", text: "n" }), {});

		const last = seen.at(-1) as RemoteChange;
		expect(last.structural).toBe(false);
		expect(last.relink).toBeDefined();
		const relink = last.relink as NonNullable<RemoteChange["relink"]>;
		expect([...relink.addedIds]).toContain("hero-new");
		// The parent whose childIds gained the node is relinked too.
		expect(relink.parentsTouched.size).toBeGreaterThan(0);
		expect([...last.ids]).toContain("hero-new");
	});
});

describe("plugin remote-apply: fast path output is unchanged", () => {
	type AnyData = {
		content?: Array<{ type: string; props: { id: string } }>;
		zones?: Record<string, unknown>;
		root?: unknown;
	};

	// Stateful harness: the default fake ctx's `getData()` does not
	// reflect dispatched actions, so `currentData` would stay empty and
	// every remote edit would fall back to `setData`. Apply `setData`
	// and `replace` to a live store so the replace fast path can engage
	// exactly as it does against a real Puck mount.
	function harnessCtx() {
		let current: AnyData | undefined;
		const dispatch = vi.fn(
			(action: { type: string } & Record<string, unknown>) => {
				if (action.type === "setData") {
					current = action.data as AnyData;
				} else if (action.type === "replace") {
					const content = [...(current?.content ?? [])];
					content[action.destinationIndex as number] = action.data as {
						type: string;
						props: { id: string };
					};
					current = { ...(current ?? {}), content };
				}
			},
		);
		const ctx = createFakeStudioContext({
			getData: (() => current) as StudioPluginContext["getData"],
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		return { dispatch, ctx };
	}

	it("a non-structural single-node remote edit dispatches exactly one `replace`, zero `setData`", async () => {
		const docA = new YDoc();
		const docB = new YDoc();
		docA.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== "replicate") applyUpdate(docB, u, "replicate");
		});
		docB.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== "replicate") applyUpdate(docA, u, "replicate");
		});

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const { dispatch, ctx } = harnessCtx();
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter: adapterA,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);
		await harness.runInit();

		adapterB.save(multiHero(["a", "b", "c"]), {}); // seed → setData
		dispatch.mockClear();

		adapterB.save(multiHero(["a", "b!", "c"]), {}); // hero-1 prop edit

		const types = dispatch.mock.calls.map(
			(c) => (c[0] as { type: string }).type,
		);
		expect(types).toEqual(["replace"]);
		const action = dispatch.mock.calls[0]![0] as {
			type: "replace";
			destinationIndex: number;
			data: { props: { id: string } };
		};
		expect(action.data.props.id).toBe("hero-1");
		expect(action.destinationIndex).toBe(1);
	});

	it("legacy adapter with no `changed` arg still dispatches via the full path", async () => {
		// Hand-rolled adapter whose subscribe omits the 3rd arg — the
		// pre-P1 contract. `changed === undefined` must keep the exact
		// O(document) behaviour (setData here: no prior currentData).
		let emit: ((ir: PageIR) => void) | undefined;
		const legacyAdapter = {
			save: vi.fn(() => "snap-1"),
			load: vi.fn(),
			list: vi.fn(() => []),
			delete: vi.fn(),
			subscribe: (cb: (ir: PageIR) => void) => {
				emit = cb;
				return () => {
					emit = undefined;
				};
			},
		} as unknown as CreateCollabPluginOptions["adapter"];

		const { dispatch, ctx } = harnessCtx();
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter: legacyAdapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);
		await harness.runInit();

		emit?.(multiHero(["x", "y"]));
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect((dispatch.mock.calls[0]![0] as { type: string }).type).toBe(
			"setData",
		);
	});
});
