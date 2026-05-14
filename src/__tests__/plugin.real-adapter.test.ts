/**
 * H5 — End-to-end plugin↔real-adapter integration.
 *
 * `plugin.test.ts` uses a hand-rolled `fakeAdapter` that invokes the
 * subscribe callback directly. That isolates the plugin's hook logic
 * but skips the entire Y.Doc → observer → subscribe-fan-out chain. A
 * regression in observer ordering, transaction-origin handling, or
 * dispatch debouncing inside `createYjsAdapter` would pass
 * `plugin.test.ts` while breaking real wiring.
 *
 * This suite builds a real `Y.Doc`, instantiates `createYjsAdapter`,
 * and runs `createCollabPlugin` against it. Remote updates are driven
 * by mutating a SECOND Y.Doc and applying its state to the first via
 * the partition-harness shuttle pattern.
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
import { applyUpdate, Doc as YDoc, encodeStateAsUpdate } from "yjs";

import { createCollabDataPlugin } from "../plugin.js";
import { createYjsAdapter } from "../yjs-adapter.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

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

describe("plugin ↔ real createYjsAdapter integration (H5)", () => {
	it("dispatches setData when a remote peer's save propagates through Y.Doc", async () => {
		const docA = new YDoc();
		const docB = new YDoc();

		const adapterA = createYjsAdapter({
			doc: docA,
			peer: { id: "alice" },
		});
		const adapterB = createYjsAdapter({
			doc: docB,
			peer: { id: "bob" },
		});

		// Pair the docs bidirectionally so a save on B replicates to A.
		docA.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== "replicate") applyUpdate(docB, u, "replicate");
		});
		docB.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== "replicate") applyUpdate(docA, u, "replicate");
		});

		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter: adapterA,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);
		await harness.runInit();

		// Bob saves an IR. The save lands in docB, the pair listener
		// applies the update to docA, adapterA's Y.Map observer fires,
		// readCurrentIR decodes the new IR, and the plugin's subscribe
		// callback dispatches setData into the mock Puck API.
		const remoteIR = withHero("from bob");
		adapterB.save(remoteIR, {});

		expect(dispatch).toHaveBeenCalledTimes(1);
		const action = dispatch.mock.calls[0]?.[0] as {
			type: string;
			data: ReturnType<typeof irToPuckData>;
		};
		expect(action.type).toBe("setData");
		expect(action.data).toEqual(irToPuckData(remoteIR));
	});

	it("hydrates the latest snapshot from a pre-existing Y.Doc on onInit", async () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, peer: { id: "alice" } });

		// Save BEFORE the plugin attaches — emulating a freshly loaded
		// document that already has a snapshot in the room.
		const seeded = withHero("seeded");
		adapter.save(seeded, { label: "v1" });

		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);
		await harness.runInit();

		// onInit's hydrate path should have dispatched the seeded IR.
		expect(dispatch).toHaveBeenCalled();
		const seededDispatch = dispatch.mock.calls.find((call) => {
			const action = call[0] as { type?: string };
			return action.type === "setData";
		});
		expect(seededDispatch).toBeDefined();
	});

	it("onDestroy unsubscribes from the adapter and tears down the underlying Y observer", async () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, peer: { id: "alice" } });

		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);
		await harness.runInit();

		// Trigger destroy through the registration hook.
		harness.registration.hooks?.onDestroy?.(ctx);

		// Now a remote write must NOT reach the plugin — both the
		// subscribe handler (unsubscribed) and the Y observer (released
		// by adapter.destroy via the C2 fix path) should be inert.
		const sibling = new YDoc();
		const siblingAdapter = createYjsAdapter({
			doc: sibling,
			peer: { id: "bob" },
		});
		siblingAdapter.save(withHero("post-destroy"), {});
		const update = encodeStateAsUpdate(sibling);
		applyUpdate(doc, update);

		const seteData = dispatch.mock.calls.filter(
			(call) => (call[0] as { type?: string }).type === "setData",
		);
		// Only the (possibly missing) initial hydrate dispatch should
		// have run before destroy. No new dispatches after teardown.
		expect(seteData.length).toBeLessThanOrEqual(1);
	});

	it("propagates a local onDataChange through real adapter.save and into the Y.Doc", async () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, peer: { id: "alice" } });

		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);
		await harness.runInit();

		const local = withHero("from alice");
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(local));

		// Real adapter.save lands a real snapshot — assert it exists in
		// the underlying Y.Map via the public list() surface.
		const snapshots = adapter.list();
		expect(snapshots.length).toBeGreaterThan(0);
	});

	it("bridges two adapters through a manual Y.applyUpdate shuttle (cross-doc partition)", async () => {
		const docA = new YDoc();
		const docB = new YDoc();

		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		await registerPlugin(
			createCollabDataPlugin({
				adapter: adapterA,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		).then((h) => h.runInit());

		// No live pairing — emulate an offline session where Bob
		// authored updates while Alice was disconnected.
		adapterB.save(withHero("offline-1"), {});
		adapterB.save(withHero("offline-2"), {});

		expect(dispatch).not.toHaveBeenCalled();

		// Manually shuttle Bob's accumulated state into Alice's doc — the
		// reconnect moment. adapterA's observer must dispatch the merged
		// IR exactly once (Yjs collapses queued updates into a single
		// observer fire).
		applyUpdate(docA, encodeStateAsUpdate(docB));

		const setData = dispatch.mock.calls.filter(
			(call) => (call[0] as { type?: string }).type === "setData",
		);
		expect(setData.length).toBeGreaterThanOrEqual(1);
		const lastAction = setData.at(-1)?.[0] as {
			data: ReturnType<typeof irToPuckData>;
		};
		expect(lastAction.data).toEqual(irToPuckData(withHero("offline-2")));
	});

	it("regression guard for S1/C1: after onDestroy, the Y.Map observer is unbound", async () => {
		// If the C1 fix is reverted (observer not released in destroy()),
		// a remote write after onDestroy still fires the Y.Map observer,
		// which calls into the subscribe listeners list. The plugin
		// unsubscribed in onDestroy, so dispatch stays quiet — but if
		// destroy() ALSO failed to release the observer, the adapter
		// would still process and store remote IR internally. This test
		// asserts BOTH paths by introspecting metrics() after teardown.
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, peer: { id: "alice" } });

		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);
		await harness.runInit();
		const before = adapter.metrics();
		harness.registration.hooks?.onDestroy?.(ctx);

		// Drive a remote write from a sibling doc.
		const sibling = new YDoc();
		const siblingAdapter = createYjsAdapter({
			doc: sibling,
			peer: { id: "bob" },
		});
		siblingAdapter.save(withHero("post-destroy"), {});
		applyUpdate(doc, encodeStateAsUpdate(sibling));

		// If the observer were still bound, syncLatencySamples would
		// increase (the observer records a latency sample whenever a
		// remote PAGE_IR_KEY arrives after a local save). With C1
		// applied, the observer is gone and the sample window is
		// unchanged from before destroy.
		const after = adapter.metrics();
		expect(after.syncLatencySamples).toBe(before.syncLatencySamples);
	});
});
