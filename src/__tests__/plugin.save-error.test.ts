import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { StudioPluginContext } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";

import { createCollabPlugin } from "../plugin.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

function makeCtx() {
	const dispatch = vi.fn();
	return createFakeStudioContext({
		getPuckApi: vi.fn(
			() => ({ dispatch }) as unknown as PuckApi,
		) as unknown as StudioPluginContext["getPuckApi"],
	});
}

describe("createCollabPlugin onSaveError", () => {
	it("invokes onSaveError when adapter.save throws synchronously", async () => {
		const adapter: SnapshotAdapter = {
			save() {
				throw new Error("backend down");
			},
			list: () => [] as SnapshotMeta[],
			load: () => createFakePageIR(),
		};
		const onSaveError = vi.fn();
		const ctx = makeCtx();
		const harness = await registerPlugin(
			createCollabPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				onSaveError,
			}),
			{ ctx },
		);
		await harness.runInit();

		const local = createFakePageIR({ rootId: "local" });
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(local));

		expect(onSaveError).toHaveBeenCalledTimes(1);
		expect(onSaveError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect((onSaveError.mock.calls[0]?.[0] as Error).message).toBe(
			"backend down",
		);
		expect(ctx._mocks.logCalls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"error",
					expect.stringContaining("outbound save threw synchronously"),
				]),
			]),
		);
	});

	it("invokes onSaveError when adapter.save returns a rejecting promise", async () => {
		const adapter: SnapshotAdapter = {
			save: () => Promise.reject(new Error("network blip")),
			list: () => [] as SnapshotMeta[],
			load: () => createFakePageIR(),
		};
		const onSaveError = vi.fn();
		const ctx = makeCtx();
		const harness = await registerPlugin(
			createCollabPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				onSaveError,
			}),
			{ ctx },
		);
		await harness.runInit();

		const local = createFakePageIR({ rootId: "local" });
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(local));
		// allow microtask queue to drain so the .catch fires
		await Promise.resolve();
		await Promise.resolve();

		expect(onSaveError).toHaveBeenCalledTimes(1);
		expect(onSaveError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect((onSaveError.mock.calls[0]?.[0] as Error).message).toBe(
			"network blip",
		);
		expect(ctx._mocks.logCalls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"error",
					expect.stringContaining("outbound save failed"),
				]),
			]),
		);
	});

	it("does not throw when onSaveError is omitted (still logs)", async () => {
		const adapter: SnapshotAdapter = {
			save: () => Promise.reject(new Error("silent failure")),
			list: () => [] as SnapshotMeta[],
			load: () => createFakePageIR(),
		};
		const ctx = makeCtx();
		const harness = await registerPlugin(
			createCollabPlugin({ adapter, puckConfig: STUB_CONFIG }),
			{ ctx },
		);
		await harness.runInit();

		const local = createFakePageIR({ rootId: "local" });
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(local));
		await Promise.resolve();
		await Promise.resolve();

		expect(ctx._mocks.logCalls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"error",
					expect.stringContaining("outbound save failed"),
				]),
			]),
		);
	});
});
