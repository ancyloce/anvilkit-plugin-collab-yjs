import type { PageIR } from "@anvilkit/core/types";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";

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
	readonly clearTimeout?: (
		handle: ReturnType<typeof setTimeout>,
	) => void;
}

interface PendingSave {
	readonly ir: PageIR;
	readonly meta: Partial<Omit<SnapshotMeta, "id" | "savedAt">>;
	readonly resolvers: ((id: string) => void)[];
	readonly rejecters: ((reason: unknown) => void)[];
}

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
	adapter: SnapshotAdapter,
	options: CreateDebouncedAdapterOptions = {},
): SnapshotAdapter {
	const ms = options.ms ?? 150;
	const setTimer = options.setTimeout ?? setTimeout;
	const clearTimer = options.clearTimeout ?? clearTimeout;

	let pending: PendingSave | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function flush(): void {
		if (!pending) return;
		const current = pending;
		pending = undefined;
		timer = undefined;
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
	};
}
