import { createFakePageIR } from "@anvilkit/core/testing";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	DebouncedAdapterDestroyedError,
	createDebouncedAdapter,
} from "../debounced-adapter.js";

interface RecordedAdapter extends SnapshotAdapter {
	readonly saveCalls: number;
	readonly destroyCalls: number;
	destroy(): void;
}

function recordingAdapter(): RecordedAdapter {
	const snapshots: SnapshotMeta[] = [];
	let destroyCount = 0;
	const wrapper = {
		get saveCalls() {
			return snapshots.length;
		},
		get destroyCalls() {
			return destroyCount;
		},
		save(ir: ReturnType<typeof createFakePageIR>) {
			void ir;
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
		load() {
			return createFakePageIR();
		},
		destroy() {
			destroyCount += 1;
		},
	};
	return wrapper as RecordedAdapter;
}

describe("createDebouncedAdapter destroy", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("rejects pending saves with DebouncedAdapterDestroyedError and never reaches the upstream save", async () => {
		const adapter = recordingAdapter();
		const debounced = createDebouncedAdapter(adapter, { ms: 50 });
		const pending = debounced.save(createFakePageIR(), {}) as Promise<string>;

		await vi.advanceTimersByTimeAsync(10);
		debounced.destroy?.();

		await expect(pending).rejects.toBeInstanceOf(
			DebouncedAdapterDestroyedError,
		);
		expect(adapter.saveCalls).toBe(0);
		expect(adapter.destroyCalls).toBe(1);
	});

	it("rejects subsequent save() calls after destroy without queuing them", async () => {
		const adapter = recordingAdapter();
		const debounced = createDebouncedAdapter(adapter, { ms: 50 });
		debounced.destroy?.();

		await expect(debounced.save(createFakePageIR(), {})).rejects.toBeInstanceOf(
			DebouncedAdapterDestroyedError,
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(adapter.saveCalls).toBe(0);
	});

	it("is idempotent — calling destroy twice forwards once and does not rethrow", () => {
		const adapter = recordingAdapter();
		const debounced = createDebouncedAdapter(adapter);
		debounced.destroy?.();
		debounced.destroy?.();
		expect(adapter.destroyCalls).toBe(1);
	});

	it("forwards destroy() even when upstream adapter has no destroy method", () => {
		const minimal: SnapshotAdapter = {
			save: () => "id",
			list: () => [],
			load: () => createFakePageIR(),
		};
		const debounced = createDebouncedAdapter(minimal);
		expect(() => debounced.destroy?.()).not.toThrow();
	});
});
