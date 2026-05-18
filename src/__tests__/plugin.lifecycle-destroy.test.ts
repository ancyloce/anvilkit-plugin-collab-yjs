/**
 * A3 — lifecycle integration: a Studio plugin wired to a
 * `createDebouncedAdapter` must reject an in-flight local save with
 * `DebouncedAdapterDestroyedError` when `<Studio>` unmounts
 * (`onDestroy` → `adapter.destroy()`), surfaced via `onSaveError`.
 */

import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { PageIR, StudioPluginContext } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";

import { createCollabDataPlugin } from "../plugin.js";
import {
	createDebouncedAdapter,
	DebouncedAdapterDestroyedError,
} from "../debounced-adapter.js";
import { syncInboundScheduler } from "./helpers/inbound.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

function recordingAdapter(): SnapshotAdapter {
	const snapshots: SnapshotMeta[] = [];
	return {
		save(ir: PageIR) {
			void ir;
			const meta: SnapshotMeta = {
				id: `id-${snapshots.length}`,
				savedAt: new Date(snapshots.length).toISOString(),
				pageIRHash: `h-${snapshots.length}`,
			};
			snapshots.push(meta);
			return meta.id;
		},
		list: () => snapshots,
		load: () => createFakePageIR(),
	};
}

describe("A3 — plugin + debounced adapter lifecycle destroy", () => {
	it("rejects the pending local save with DebouncedAdapterDestroyedError on onDestroy", async () => {
		// Scheduler that NEVER fires → the debounced save stays pending
		// until destroy() rejects it.
		let captured: (() => void) | undefined;
		const debounced = createDebouncedAdapter(recordingAdapter(), {
			ms: 1000,
			setTimeout: ((fn: () => void) => {
				captured = fn;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			clearTimeout: () => {
				captured = undefined;
			},
		});

		const onSaveError = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter: debounced,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "local" },
				onSaveError,
				inboundScheduler: syncInboundScheduler(),
			}),
			{ ctx },
		);
		await harness.runInit();
		await harness.runReady();

		// Genuine local edit → debounced.save() returns a promise that
		// stays pending (scheduler captured, never fired).
		await harness.registration.hooks?.onDataChange?.(
			ctx,
			irToPuckData(createFakePageIR({ rootId: "edited" })),
		);
		expect(captured).toBeTypeOf("function"); // a flush was scheduled
		expect(onSaveError).not.toHaveBeenCalled();

		// Unmount: plugin.onDestroy → adapter.destroy() rejects pending.
		await harness.runDestroy();
		await Promise.resolve();

		expect(onSaveError).toHaveBeenCalledTimes(1);
		expect(onSaveError.mock.calls[0]?.[0]).toBeInstanceOf(
			DebouncedAdapterDestroyedError,
		);
	});
});
