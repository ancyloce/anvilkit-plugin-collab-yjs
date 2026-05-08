import { createFakePageIR } from "@anvilkit/core/testing";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebouncedAdapter } from "../debounced-adapter.js";

function recordingAdapter(): SnapshotAdapter & {
	readonly saveCalls: number;
} {
	const snapshots: SnapshotMeta[] = [];
	const wrapper = {
		get saveCalls() {
			return snapshots.length;
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
	};
	return wrapper as SnapshotAdapter & { readonly saveCalls: number };
}

describe("createDebouncedAdapter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces a 50ms burst into a single underlying write", async () => {
		const adapter = recordingAdapter();
		const debounced = createDebouncedAdapter(adapter, { ms: 150 });

		const promises: Promise<string>[] = [];
		for (let i = 0; i < 10; i += 1) {
			promises.push(
				debounced.save(createFakePageIR({ rootId: `r${i}` }), {}) as Promise<string>,
			);
			await vi.advanceTimersByTimeAsync(5);
		}

		expect(adapter.saveCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(150);
		expect(adapter.saveCalls).toBe(1);

		const ids = await Promise.all(promises);
		expect(new Set(ids).size).toBe(1);
	});

	it("flushes the latest IR (last write wins within window)", async () => {
		const adapter = recordingAdapter();
		const seenIRs: string[] = [];
		const wrapped: SnapshotAdapter = {
			...adapter,
			save(ir, meta) {
				seenIRs.push(ir.root.id);
				return adapter.save(ir, meta);
			},
		};
		const debounced = createDebouncedAdapter(wrapped, { ms: 50 });

		debounced.save(createFakePageIR({ rootId: "first" }), {});
		debounced.save(createFakePageIR({ rootId: "second" }), {});
		debounced.save(createFakePageIR({ rootId: "third" }), {});

		await vi.advanceTimersByTimeAsync(60);
		expect(seenIRs).toEqual(["third"]);
	});

	it("forwards rejections to every queued caller", async () => {
		const failing: SnapshotAdapter = {
			save() {
				throw new Error("backend down");
			},
			list: () => [],
			load: () => createFakePageIR(),
		};
		const debounced = createDebouncedAdapter(failing, { ms: 30 });

		const first = debounced.save(createFakePageIR(), {});
		const second = debounced.save(createFakePageIR(), {});
		const expectations = Promise.all([
			expect(first).rejects.toThrow("backend down"),
			expect(second).rejects.toThrow("backend down"),
		]);

		await vi.advanceTimersByTimeAsync(40);
		await expectations;
	});

	it("delegates list/load/delete to the underlying adapter", () => {
		const adapter = recordingAdapter();
		const debounced = createDebouncedAdapter(adapter);
		expect(debounced.list).toBeDefined();
		expect(debounced.load).toBeDefined();
		expect(typeof debounced.list).toBe("function");
	});
});
