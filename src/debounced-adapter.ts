import type { PageIR } from "@anvilkit/core/types";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";

import type { MetricsSnapshot } from "./types.js";

export interface CreateDebouncedAdapterOptions {
	/**
	 * Quiet window after which the latest pending `save()` is flushed
	 * to the underlying adapter. Default: 150 ms.
	 */
	readonly ms?: number;
	/**
	 * Optional scheduler override. Defaults to `setTimeout` /
	 * `clearTimeout`. Tests use this to inject a fake scheduler.
	 */
	readonly setTimeout?: (
		fn: () => void,
		ms: number,
	) => ReturnType<typeof setTimeout>;
	readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface PendingSave {
	readonly ir: PageIR;
	readonly meta: Partial<Omit<SnapshotMeta, "id" | "savedAt">>;
	readonly resolvers: ((id: string) => void)[];
	readonly rejecters: ((reason: unknown) => void)[];
}

/**
 * `SnapshotAdapter` extended with the optional metrics surface from
 * `YjsSnapshotAdapter`. Used as both the upstream type accepted by
 * `createDebouncedAdapter` and the return type — when the upstream
 * adapter exposes `metrics()`, the debouncer overlays its own
 * coalescing ratio on top of the upstream snapshot.
 */
export type SnapshotAdapterWithMetrics = SnapshotAdapter & {
	readonly metrics?: () => MetricsSnapshot;
};

/**
 * Wrap a `SnapshotAdapter` so that bursts of `save()` calls within `ms`
 * coalesce into a single underlying write. The latest IR wins; every
 * caller that issued a save during the window receives the resolved id
 * (or the rejection) of that single flush.
 *
 * Backpressure target: slider drags, rapid typing, and bulk operations.
 * Underlying adapter behavior is preserved for `list`, `load`, `delete`,
 * `subscribe`, and `presence`.
 */
export function createDebouncedAdapter(
	adapter: SnapshotAdapterWithMetrics,
	options: CreateDebouncedAdapterOptions = {},
): SnapshotAdapterWithMetrics {
	const ms = options.ms ?? 150;
	const setTimer = options.setTimeout ?? setTimeout;
	const clearTimer = options.clearTimeout ?? clearTimeout;

	let pending: PendingSave | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saveCalls = 0;
	let transportWrites = 0;

	function flush(): void {
		if (!pending) return;
		const current = pending;
		pending = undefined;
		timer = undefined;
		transportWrites += 1;
		try {
			const result = adapter.save(current.ir, current.meta);
			Promise.resolve(result).then(
				(id) => {
					for (const resolve of current.resolvers) resolve(id);
				},
				(error: unknown) => {
					for (const reject of current.rejecters) reject(error);
				},
			);
		} catch (error) {
			for (const reject of current.rejecters) reject(error);
		}
	}

	return {
		save(ir, meta) {
			saveCalls += 1;
			return new Promise<string>((resolve, reject) => {
				if (pending) {
					pending = {
						ir,
						meta,
						resolvers: [...pending.resolvers, resolve],
						rejecters: [...pending.rejecters, reject],
					};
				} else {
					pending = { ir, meta, resolvers: [resolve], rejecters: [reject] };
				}
				if (timer !== undefined) clearTimer(timer);
				timer = setTimer(flush, ms);
			});
		},
		list: adapter.list.bind(adapter),
		load: adapter.load.bind(adapter),
		delete: adapter.delete?.bind(adapter),
		subscribe: adapter.subscribe?.bind(adapter),
		presence: adapter.presence,
		metrics: adapter.metrics
			? (): MetricsSnapshot => {
					const upstream = adapter.metrics?.();
					if (!upstream) {
						return {
							saveCount: saveCalls,
							transportWrites,
							saveCoalescingRatio:
								saveCalls === 0 ? 1 : transportWrites / saveCalls,
							dispatchFailures: 0,
							awarenessChurn: 0,
							syncLatencyP50Ms: null,
							syncLatencyP95Ms: null,
							syncLatencySamples: 0,
							degraded: false,
						};
					}
					return {
						...upstream,
						saveCount: saveCalls,
						transportWrites,
						saveCoalescingRatio:
							saveCalls === 0 ? 1 : transportWrites / saveCalls,
					};
				}
			: undefined,
	};
}
