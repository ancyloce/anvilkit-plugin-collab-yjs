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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebouncedAdapter } from "../debounced-adapter.js";
import { createCollabDataPlugin } from "../plugin.js";

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

describe("createCollabDataPlugin", () => {
	it("compiles through compilePlugins and registers the expected meta", async () => {
		const adapter = fakeAdapter();
		const runtime = await compilePlugins(
			[createCollabDataPlugin({ adapter })],
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

		const harness = await registerPlugin(createCollabDataPlugin({ adapter }), {
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

		const harness = await registerPlugin(createCollabDataPlugin({ adapter }), {
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
			createCollabDataPlugin({ adapter, puckConfig: STUB_CONFIG }),
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
			createCollabDataPlugin({ adapter, puckConfig: STUB_CONFIG }),
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

	it("validateRemoteIR null return rejects the dispatch and logs a warning", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const onValidationFailure = vi.fn();
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				validateRemoteIR: () => null,
				onValidationFailure,
			}),
			{ ctx },
		);
		await harness.runInit();

		adapter.pushUpdate(createFakePageIR({ rootId: "rejected" }));

		expect(dispatch).not.toHaveBeenCalled();
		expect(onValidationFailure).toHaveBeenCalledWith({ kind: "rejected" });
		expect(ctx._mocks.logCalls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"warn",
					expect.stringContaining("rejected by validator"),
				]),
			]),
		);
	});

	it("validateRemoteIR throw is treated as rejection and includes the error", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const onValidationFailure = vi.fn();
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				validateRemoteIR: () => {
					throw new Error("not a valid IR");
				},
				onValidationFailure,
			}),
			{ ctx },
		);
		await harness.runInit();

		adapter.pushUpdate(createFakePageIR({ rootId: "rejected" }));

		expect(dispatch).not.toHaveBeenCalled();
		expect(onValidationFailure).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "threw" }),
		);
	});

	it("validateRemoteIR returning a transformed IR forwards it to dispatch", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const replacement = createFakePageIR({ rootId: "rewritten" });
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				validateRemoteIR: () => replacement,
			}),
			{ ctx },
		);
		await harness.runInit();

		adapter.pushUpdate(createFakePageIR({ rootId: "incoming" }));

		expect(dispatch).toHaveBeenCalledWith({
			type: "setData",
			data: irToPuckData(replacement),
		});
	});

	describe("with createDebouncedAdapter wrapper", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("coalesces a burst of onDataChange writes into a single underlying save", async () => {
			const adapter = fakeAdapter();
			const debounced = createDebouncedAdapter(adapter, { ms: 100 });
			const dispatch = vi.fn();
			const ctx = createFakeStudioContext({
				getPuckApi: vi.fn(
					() => ({ dispatch }) as unknown as PuckApi,
				) as unknown as StudioPluginContext["getPuckApi"],
			});
			const harness = await registerPlugin(
				createCollabDataPlugin({ adapter: debounced, puckConfig: STUB_CONFIG }),
				{ ctx },
			);
			await harness.runInit();

			// 10 rapid local edits within the debounce window. Each
			// edit produces a distinct PuckData via irToPuckData so the
			// debouncer must keep the latest one rather than dedup
			// identical writes.
			for (let i = 0; i < 10; i++) {
				const ir = createFakePageIR();
				const puckData = irToPuckData(ir);
				const stamped = {
					...(puckData as Record<string, unknown>),
					content: [{ type: "Hero", props: { headline: `burst-${i}` } }],
				};
				await harness.registration.hooks?.onDataChange?.(ctx, stamped);
				await vi.advanceTimersByTimeAsync(5);
			}

			// During the burst, the underlying adapter has not yet been
			// flushed (only the first 50ms of the 100ms debounce window
			// has elapsed when the loop ends).
			expect(adapter.savedIRs).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(150);

			// One coalesced write reaches the underlying adapter,
			// regardless of how many onDataChange events fired during
			// the burst (target ratio: ≤ 0.5 vs un-debounced from PRD
			// §3.1 acceptance criteria).
			expect(adapter.savedIRs).toHaveLength(1);
		});
	});

	it("logs a warning when the adapter has no subscribe()", async () => {
		const adapter: SnapshotAdapter = {
			save: () => "id",
			list: () => [],
			load: () => createFakePageIR(),
		};
		const ctx = createFakeStudioContext();
		const harness = await registerPlugin(createCollabDataPlugin({ adapter }), {
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
