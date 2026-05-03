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
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";

import { createCollabPlugin } from "../plugin.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

function fakeAdapter(): SnapshotAdapter & {
	pushUpdate: (
		ir?: ReturnType<typeof createFakePageIR>,
		peer?: PeerInfo,
	) => void;
	readonly savedIRs: ReturnType<typeof createFakePageIR>[];
} {
	let saved = createFakePageIR();
	let listener: ((ir: typeof saved, peer?: PeerInfo) => void) | undefined;
	const snapshots: SnapshotMeta[] = [];
	const savedIRs: ReturnType<typeof createFakePageIR>[] = [];
	return {
		savedIRs,
		save(ir) {
			saved = ir as typeof saved;
			savedIRs.push(saved);
			const meta: SnapshotMeta = {
				id: `id-${snapshots.length}`,
				savedAt: new Date(snapshots.length).toISOString(),
				pageIRHash: `hash-${snapshots.length}`,
			};
			snapshots.push(meta);
			return meta.id;
		},
		list() {
			return snapshots;
		},
		load(id) {
			if (snapshots.length > 0 && !snapshots.some((meta) => meta.id === id)) {
				throw new Error(`missing ${id}`);
			}
			return saved;
		},
		subscribe(onUpdate) {
			listener = onUpdate;
			return () => {
				listener = undefined;
			};
		},
		pushUpdate(ir, peer) {
			if (ir) saved = ir;
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

		adapter.pushUpdate(undefined, { id: "remote" });

		expect(dispatch).toHaveBeenCalledTimes(1);
		const action = dispatch.mock.calls[0]?.[0] as {
			type: string;
			data: ReturnType<typeof irToPuckData>;
		};
		expect(action.type).toBe("setData");
		expect(action.data).toEqual(irToPuckData(adapter.load("missing-ok")));
	});

	it("hydrates the latest snapshot on init after subscribing", async () => {
		const adapter = fakeAdapter();
		const initial = createFakePageIR({
			rootId: "hydrated-root",
			metadata: { createdAt: new Date(0).toISOString() },
		});
		adapter.save(initial, {});
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

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith({
			type: "setData",
			data: irToPuckData(initial),
		});
	});

	it("suppresses every matching onDataChange from multiple queued remote updates", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabPlugin({ adapter, puckConfig: STUB_CONFIG }),
			{ ctx },
		);
		await harness.runInit();

		const firstRemote = createFakePageIR({ rootId: "remote-1" });
		const secondRemote = createFakePageIR({ rootId: "remote-2" });
		adapter.pushUpdate(firstRemote);
		adapter.pushUpdate(secondRemote);

		await harness.registration.hooks?.onDataChange?.(
			ctx,
			irToPuckData(firstRemote),
		);
		await harness.registration.hooks?.onDataChange?.(
			ctx,
			irToPuckData(secondRemote),
		);
		expect(adapter.savedIRs).toHaveLength(0);

		const local = createFakePageIR({ rootId: "local" });
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(local));
		expect(adapter.savedIRs).toHaveLength(1);
	});

	it("does not leave a stale remote mute when dispatch throws", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn(() => {
			throw new Error("dispatch failed");
		});
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabPlugin({ adapter, puckConfig: STUB_CONFIG }),
			{ ctx },
		);
		await harness.runInit();

		const remote = createFakePageIR({ rootId: "remote" });
		adapter.pushUpdate(remote);

		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(remote));
		expect(adapter.savedIRs).toHaveLength(1);
		expect(ctx._mocks.logCalls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"error",
					expect.stringContaining("remote update dispatch failed"),
				]),
			]),
		);
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
