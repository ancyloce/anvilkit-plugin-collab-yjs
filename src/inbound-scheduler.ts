import type { PageIR } from "@anvilkit/core/types";
import type { PeerInfo } from "@anvilkit/plugin-version-history";

/**
 * Inbound coalescing scheduler (H1).
 *
 * The remote subscribe path used to call `dispatchRemoteIR`
 * synchronously inside the Yjs/provider call stack. A websocket burst
 * therefore ran the full remote pipeline — validate, IR->Puck convert,
 * stable stringify, replace planning, synchronous Puck dispatch — once
 * per inbound message with no frame budget. On a 2000-node page that
 * froze the editor.
 *
 * This buffers inbound IRs latest-wins per room and flushes at most
 * once per animation frame (or a configured budget). Superseded IRs
 * are dropped before any conversion/dispatch happens and counted so
 * hosts can see the adapter protecting the UI.
 *
 * Hydration deliberately does NOT go through here — it is a one-shot
 * initial paint, not a coalescing candidate, and must stay synchronous
 * with `onInit` so hosts (and tests) see post-init state immediately.
 */
export interface InboundScheduler {
	/** Buffer the latest remote IR for `roomKey` (latest-wins). */
	enqueue(roomKey: string, ir: PageIR, peer: PeerInfo | undefined): void;
	/** Synchronously drain (a single room, or all). Used by tests/teardown. */
	flushNow(roomKey?: string): void;
	/** Cancel the pending frame and drop all buffers. */
	destroy(): void;
}

export interface InboundSchedulerHandleScheduler {
	request(cb: () => void): unknown;
	cancel(handle: unknown): void;
}

export interface CreateInboundSchedulerOptions {
	/**
	 * Called with the winning IR for a room when the buffer flushes.
	 * `queueDelayMs` is the wall time the IR waited in the buffer.
	 */
	readonly flush: (
		roomKey: string,
		ir: PageIR,
		peer: PeerInfo | undefined,
		queueDelayMs: number,
	) => void;
	/** Reports the number of IRs dropped by coalescing (to metrics). */
	readonly onCoalesced?: (count: number) => void;
	/** Fallback cadence (ms) when `requestAnimationFrame` is absent. */
	readonly budgetMs?: number;
	/**
	 * Scheduler override. Defaults to `requestAnimationFrame` when
	 * available, else `setTimeout(budgetMs)`. Tests inject a manual
	 * scheduler so flushes are deterministic.
	 */
	readonly scheduler?: InboundSchedulerHandleScheduler;
}

interface BufferedEntry {
	ir: PageIR;
	peer: PeerInfo | undefined;
	firstEnqueuedAt: number;
}

const DEFAULT_BUDGET_MS = 16;

interface RacedHandle {
	raf?: number;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * I4 — when `requestAnimationFrame` exists, race it against a
 * wall-clock `setTimeout`. Headless / backgrounded / occluded tabs
 * park rAF indefinitely; without a failsafe the buffered remote IRs
 * never flush and the collaborator silently stops receiving edits
 * until the tab is refocused. The timeout guarantees the flush lands
 * within `max(budgetMs, FAILSAFE_FLOOR_MS)` regardless of rAF state.
 * Whichever fires first runs the callback exactly once and cancels the
 * other; `cancel` clears both.
 */
const FAILSAFE_FLOOR_MS = 250;

function defaultScheduler(budgetMs: number): InboundSchedulerHandleScheduler {
	if (typeof requestAnimationFrame === "function") {
		const failsafeMs = Math.max(budgetMs, FAILSAFE_FLOOR_MS);
		return {
			request: (cb) => {
				const handle: RacedHandle = {};
				let fired = false;
				const fire = () => {
					if (fired) return;
					fired = true;
					if (handle.raf !== undefined) cancelAnimationFrame(handle.raf);
					if (handle.timer !== undefined) clearTimeout(handle.timer);
					cb();
				};
				handle.raf = requestAnimationFrame(fire);
				handle.timer = setTimeout(fire, failsafeMs);
				return handle;
			},
			cancel: (h) => {
				const handle = h as RacedHandle;
				if (handle.raf !== undefined) cancelAnimationFrame(handle.raf);
				if (handle.timer !== undefined) clearTimeout(handle.timer);
			},
		};
	}
	return {
		request: (cb) => setTimeout(cb, budgetMs),
		cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

export function createInboundScheduler(
	options: CreateInboundSchedulerOptions,
): InboundScheduler {
	const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const scheduler = options.scheduler ?? defaultScheduler(budgetMs);
	const buffers = new Map<string, BufferedEntry>();
	let handle: unknown;
	let scheduled = false;
	let destroyed = false;

	function drainRoom(roomKey: string): void {
		const entry = buffers.get(roomKey);
		if (!entry) return;
		buffers.delete(roomKey);
		const queueDelayMs = Math.max(0, Date.now() - entry.firstEnqueuedAt);
		options.flush(roomKey, entry.ir, entry.peer, queueDelayMs);
	}

	function onFrame(): void {
		scheduled = false;
		handle = undefined;
		if (destroyed) return;
		// Snapshot keys first: a flush callback could re-enqueue.
		for (const roomKey of [...buffers.keys()]) drainRoom(roomKey);
	}

	function ensureScheduled(): void {
		if (scheduled || destroyed) return;
		scheduled = true;
		handle = scheduler.request(onFrame);
	}

	return {
		enqueue(roomKey, ir, peer): void {
			if (destroyed) return;
			const existing = buffers.get(roomKey);
			if (existing) {
				// The previously buffered IR for this room never made it
				// to Puck — it is superseded and dropped.
				options.onCoalesced?.(1);
				existing.ir = ir;
				existing.peer = peer;
			} else {
				buffers.set(roomKey, {
					ir,
					peer,
					firstEnqueuedAt: Date.now(),
				});
			}
			ensureScheduled();
		},
		flushNow(roomKey?: string): void {
			if (roomKey !== undefined) {
				drainRoom(roomKey);
				return;
			}
			for (const key of [...buffers.keys()]) drainRoom(key);
		},
		destroy(): void {
			destroyed = true;
			if (handle !== undefined) scheduler.cancel(handle);
			handle = undefined;
			scheduled = false;
			buffers.clear();
		},
	};
}
