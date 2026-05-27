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

	it("logs the raw Error (name + stack survive) when message is empty", async () => {
		// An Error whose `message` is empty used to collapse the logged meta
		// to `{ error: undefined }` -> rendered as a bare `{}` in the Next dev
		// overlay, hiding the name/stack. The plugin now forwards the raw
		// error so core's `normalizeLogError` can surface name + stack.
		class TornDownError extends Error {
			override readonly name = "TornDownError";
			constructor() {
				super("");
			}
		}
		const adapter: SnapshotAdapter = {
			save: () => Promise.reject(new TornDownError()),
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

		const saveFailedCall = ctx._mocks.logCalls.find(
			([level, message]) =>
				level === "error" &&
				typeof message === "string" &&
				message.includes("outbound save failed"),
		);
		expect(saveFailedCall).toBeDefined();
		const meta = saveFailedCall?.[2] as { error?: unknown } | undefined;
		expect(meta?.error).toBeInstanceOf(Error);
		expect((meta?.error as Error).name).toBe("TornDownError");
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
