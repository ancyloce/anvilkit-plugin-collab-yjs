import { compilePlugins } from "@anvilkit/core";
import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { StudioPluginContext } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import type {
	PeerInfo,
	SnapshotAdapter,
} from "@anvilkit/plugin-version-history";
import type { PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";

import { createCollabPlugin } from "../plugin.js";

function fakeAdapter(): SnapshotAdapter & {
	pushUpdate: (peer?: PeerInfo) => void;
} {
	let saved = createFakePageIR();
	let listener: ((ir: typeof saved, peer?: PeerInfo) => void) | undefined;
	return {
		save(ir) {
			saved = ir as typeof saved;
			return "id";
		},
		list() {
			return [];
		},
		load() {
			return saved;
		},
		subscribe(onUpdate) {
			listener = onUpdate;
			return () => {
				listener = undefined;
			};
		},
		pushUpdate(peer) {
			listener?.(saved, peer);
		},
	};
}

describe("createCollabPlugin", () => {
	it("compiles through compilePlugins and registers the expected meta", async () => {
		const adapter = fakeAdapter();
		const runtime = await compilePlugins(
			[createCollabPlugin({ adapter })],
			createFakeStudioContext(),
		);
		expect(runtime.pluginMeta).toHaveLength(1);
		expect(runtime.pluginMeta[0]?.id).toBe("anvilkit-plugin-collab-yjs");
	});

	it("subscribes on init and dispatches setData on incoming updates", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});

		const harness = await registerPlugin(createCollabPlugin({ adapter }), {
			ctx,
		});
		await harness.runInit();

		adapter.pushUpdate({ id: "remote" });

		expect(dispatch).toHaveBeenCalledTimes(1);
		const action = dispatch.mock.calls[0]?.[0] as {
			type: string;
			data: ReturnType<typeof irToPuckData>;
		};
		expect(action.type).toBe("setData");
		expect(action.data).toEqual(irToPuckData(adapter.load("id")));
	});

	it("logs a warning when the adapter has no subscribe()", async () => {
		const adapter: SnapshotAdapter = {
			save: () => "id",
			list: () => [],
			load: () => createFakePageIR(),
		};
		const ctx = createFakeStudioContext();
		const harness = await registerPlugin(createCollabPlugin({ adapter }), {
			ctx,
		});
		await harness.runInit();
		expect(ctx._mocks.logCalls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"warn",
					expect.stringContaining("subscribe()"),
				]),
			]),
		);
	});
});
