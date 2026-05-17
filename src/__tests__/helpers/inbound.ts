import type { InboundSchedulerHandleScheduler } from "../../inbound-scheduler.js";

/**
 * Synchronous inbound scheduler for tests that assert dispatch
 * behavior immediately after `adapter.pushUpdate(...)`. Runs the flush
 * callback inline so the H1 coalescing deferral does not require
 * pumping timers in every legacy test. Coalescing-specific behavior is
 * covered by `inbound-scheduler.test.ts` with a manual pump scheduler.
 */
export function syncInboundScheduler(): InboundSchedulerHandleScheduler {
	return {
		request: (cb) => {
			cb();
			return 0;
		},
		cancel: () => {
			/* nothing to cancel — request ran inline */
		},
	};
}

/**
 * Manual scheduler: buffers requested callbacks until `flush()` is
 * called, so a test can enqueue several updates and assert they
 * coalesce into a single dispatch.
 */
export function manualInboundScheduler(): {
	scheduler: InboundSchedulerHandleScheduler;
	flush: () => void;
	pending: () => number;
} {
	const queue: (() => void)[] = [];
	return {
		scheduler: {
			request: (cb) => {
				queue.push(cb);
				return queue.length;
			},
			cancel: () => {
				queue.length = 0;
			},
		},
		flush: () => {
			const callbacks = [...queue];
			queue.length = 0;
			for (const cb of callbacks) cb();
		},
		pending: () => queue.length,
	};
}
