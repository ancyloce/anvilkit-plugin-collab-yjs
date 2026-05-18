/**
 * Stage 3 (§3.4) — a non-structural remote edit scopes the inbound
 * `policy.canEdit` walk and the dirty-field shield to the changed ids
 * (∪ locally-dirty ids), instead of a full-tree pass. Structural /
 * legacy (`changed === undefined`) keeps the full walk. Correctness:
 * a locally-dirty prop is STILL shielded under scope.
 */

import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { PageIR, StudioPluginContext } from "@anvilkit/core/types";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";

import { createCollabDataPlugin as baseCollabPlugin } from "../plugin.js";
import type { CreateCollabPluginOptions } from "../types.js";
import { createYjsAdapter } from "../yjs-adapter.js";
import { syncInboundScheduler } from "./helpers/inbound.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

const createPlugin = (o: CreateCollabPluginOptions) =>
	baseCollabPlugin({
		...o,
		inboundScheduler: o.inboundScheduler ?? syncInboundScheduler(),
	});

function doc(labels: ReadonlyArray<string>): PageIR {
	const base = createFakePageIR();
	return {
		...base,
		root: {
			...base.root,
			children: labels.map((text, i) => ({
				id: `n-${i}`,
				type: "Hero",
				props: { text },
			})),
		},
	};
}

function replicatedDocs() {
	const docA = new YDoc();
	const docB = new YDoc();
	docA.on("update", (u: Uint8Array, o: unknown) => {
		if (o !== "replicate") applyUpdate(docB, u, "replicate");
	});
	docB.on("update", (u: Uint8Array, o: unknown) => {
		if (o !== "replicate") applyUpdate(docA, u, "replicate");
	});
	return { docA, docB };
}

describe("Stage 3 — scoped inbound policy", () => {
	it("evaluates policy.canEdit only for the changed node on a non-structural remote edit", async () => {
		const { docA, docB } = replicatedDocs();
		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "a" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "b" } });

		const canEdit = vi.fn(() => true);
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createPlugin({
				adapter: adapterA,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "a" },
				policy: { canEdit },
			}),
			{ ctx },
		);
		await harness.runInit();

		adapterB.save(doc(["v0-0", "v0-1", "v0-2"]), {}); // seed (structural)
		canEdit.mockClear();

		// One node's prop changes → non-structural; adapterA's observer
		// derives changed = { ids:{n-1}, structural:false }.
		adapterB.save(doc(["v0-0", "v1", "v0-2"]), {});

		const ids = new Set(
			canEdit.mock.calls.map((c) => (c[0] as { id: string }).id),
		);
		expect(ids.has("n-1")).toBe(true);
		expect(ids.has("n-0")).toBe(false);
		expect(ids.has("n-2")).toBe(false);
		expect(ids.has("root")).toBe(false);
	});

	it("legacy adapter (no changed descriptor) keeps the full-tree policy walk", async () => {
		const { docA, docB } = replicatedDocs();
		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "a" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "b" } });
		// Strip the 3rd subscribe arg → pre-P1 O(document) behaviour.
		const legacy = {
			...adapterA,
			subscribe: (cb: (ir: PageIR, peer?: unknown) => void) =>
				adapterA.subscribe((ir, peer) => cb(ir, peer)),
		} as unknown as CreateCollabPluginOptions["adapter"];

		const canEdit = vi.fn(() => true);
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createPlugin({
				adapter: legacy,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "a" },
				policy: { canEdit },
			}),
			{ ctx },
		);
		await harness.runInit();
		adapterB.save(doc(["v0-0", "v0-1", "v0-2"]), {});
		canEdit.mockClear();
		adapterB.save(doc(["v0-0", "v1", "v0-2"]), {});

		const ids = new Set(
			canEdit.mock.calls.map((c) => (c[0] as { id: string }).id),
		);
		// Full walk: every node (and root) is evaluated.
		expect(ids.has("n-0")).toBe(true);
		expect(ids.has("n-1")).toBe(true);
		expect(ids.has("n-2")).toBe(true);
	});

	it("still shields a locally-dirty prop the remote did not touch (dirty ∈ scope)", async () => {
		const { docA, docB } = replicatedDocs();
		const adapterA = createYjsAdapter({ doc: docA, peer: { id: "a" } });
		const adapterB = createYjsAdapter({ doc: docB, peer: { id: "b" } });

		const setDataCalls: Array<{ content?: Array<{ props: { id: string } }> }> =
			[];
		const dispatch = vi.fn(
			(action: { type: string } & Record<string, unknown>) => {
				if (action.type === "setData") {
					setDataCalls.push(action.data as { content?: [] });
				}
			},
		);
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createPlugin({
				adapter: adapterA,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "a" },
			}),
			{ ctx },
		);
		const onChange = harness.registration.hooks?.onDataChange as (
			c: unknown,
			d: unknown,
		) => Promise<void>;
		await harness.runInit();

		// Converged baseline.
		adapterB.save(doc(["base-0", "base-1", "base-2"]), {});

		// Local user edits n-0 (still unsaved → pending shadow). The
		// fake adapter.save records it; localShadow.pending is set.
		await onChange(ctx, {
			content: [
				{ type: "Hero", props: { id: "n-0", text: "LOCAL-UNSAVED" } },
				{ type: "Hero", props: { id: "n-1", text: "base-1" } },
				{ type: "Hero", props: { id: "n-2", text: "base-2" } },
			],
			root: {},
		});
		dispatch.mockClear();
		setDataCalls.length = 0;

		// Remote peer edits a DIFFERENT node (n-2). Scope = {n-2} ∪
		// dirty{n-0}. The shield must still keep n-0's local value.
		adapterB.save(doc(["base-0", "base-1", "remote-2"]), {});

		const last = setDataCalls.at(-1);
		const items = last?.content ?? [];
		const n0 = items.find((i) => i.props.id === "n-0") as
			| { props: { text?: string } }
			| undefined;
		const n2 = items.find((i) => i.props.id === "n-2") as
			| { props: { text?: string } }
			| undefined;
		// Shielded: local unsaved value preserved despite remote merge.
		expect(n0?.props.text).toBe("LOCAL-UNSAVED");
		// Remote change to the untouched node still converges.
		expect(n2?.props.text).toBe("remote-2");
	});
});
