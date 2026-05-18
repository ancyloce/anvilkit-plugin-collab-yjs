/**
 * C3 — initial snapshot hydration timing.
 *
 * `onInit` fires before Puck's effect-time binder captures
 * `getPuckApi()`. In a real `<Studio>` mount, probing `getPuckApi()`
 * during `onInit` throws, so hydration MUST defer to the post-mount
 * `onReady` hook instead of silently failing the initial paint.
 * Headless / test contexts expose a working `getPuckApi()` during
 * `onInit`, so hydration still runs there — and must never run twice.
 */

import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { PageIR, StudioPluginContext } from "@anvilkit/core/types";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";
import { Doc as YDoc } from "yjs";

import { createCollabDataPlugin as baseCollabPlugin } from "../plugin.js";
import type { CreateCollabPluginOptions } from "../types.js";
import { createYjsAdapter } from "../yjs-adapter.js";
import { syncInboundScheduler } from "./helpers/inbound.js";

const createCollabDataPlugin = (o: CreateCollabPluginOptions) =>
	baseCollabPlugin({
		...o,
		inboundScheduler: o.inboundScheduler ?? syncInboundScheduler(),
	});

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

function seededAdapter() {
	const doc = new YDoc();
	const adapter = createYjsAdapter({ doc, peer: { id: "alice" } });
	adapter.save(withHero("seeded"), { label: "v1" });
	return adapter;
}

function setDataCalls(dispatch: ReturnType<typeof vi.fn>): unknown[] {
	return dispatch.mock.calls.filter(
		(c) => (c[0] as { type?: string }).type === "setData",
	);
}

describe("C3 — hydration timing (onInit vs onReady)", () => {
	it("defers hydration to onReady when getPuckApi() is unbound during onInit", async () => {
		const adapter = seededAdapter();
		const dispatch = vi.fn();
		let bound = false;
		const ctx = createFakeStudioContext({
			getPuckApi: (() => {
				if (!bound) throw new Error("PUCK_API_UNBOUND (binder not ready)");
				return { dispatch } as unknown as PuckApi;
			}) as unknown as StudioPluginContext["getPuckApi"],
		});

		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
			}),
			{ ctx },
		);

		// onInit must NOT hydrate while the API is unbound — and must
		// not throw or log a dispatch error doing so.
		await harness.runInit();
		expect(setDataCalls(dispatch)).toHaveLength(0);

		// Binder captures the API; onReady replays the deferred hydrate.
		bound = true;
		await harness.runReady();
		expect(setDataCalls(dispatch).length).toBeGreaterThan(0);

		// Idempotent: a second onReady must not re-hydrate.
		const after = setDataCalls(dispatch).length;
		await harness.runReady();
		expect(setDataCalls(dispatch)).toHaveLength(after);
	});

	it("hydrates synchronously in onInit when getPuckApi() is available (headless), exactly once", async () => {
		const adapter = seededAdapter();
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
		expect(setDataCalls(dispatch)).toHaveLength(1);

		// onReady is a no-op once onInit already hydrated.
		await harness.runReady();
		expect(setDataCalls(dispatch)).toHaveLength(1);
	});
});
