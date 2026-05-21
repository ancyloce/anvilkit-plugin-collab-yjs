import type { PageIR } from "@anvilkit/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInboundScheduler } from "../utils/inbound-scheduler.js";
import { manualInboundScheduler } from "./helpers/inbound.js";

function ir(rootId: string): PageIR {
	return {
		version: "1",
		root: { id: rootId, type: "Root", props: {} },
		assets: [],
		metadata: {},
	} as PageIR;
}

describe("createInboundScheduler (H1)", () => {
	it("coalesces a burst to the latest IR with one flush and counts drops", () => {
		const flush = vi.fn();
		const coalesced = vi.fn();
		const manual = manualInboundScheduler();
		const s = createInboundScheduler({
			flush,
			onCoalesced: coalesced,
			scheduler: manual.scheduler,
		});

		s.enqueue("default", ir("a"), { id: "p" });
		s.enqueue("default", ir("b"), { id: "p" });
		s.enqueue("default", ir("c"), { id: "p" });
		// Nothing dispatched until the frame fires.
		expect(flush).not.toHaveBeenCalled();
		// Two earlier IRs were superseded.
		expect(coalesced).toHaveBeenCalledTimes(2);

		manual.flush();
		expect(flush).toHaveBeenCalledTimes(1);
		const [room, latest, peer, delay] = flush.mock.calls[0]!;
		expect(room).toBe("default");
		expect((latest as PageIR).root.id).toBe("c");
		expect(peer).toEqual({ id: "p" });
		expect(typeof delay).toBe("number");
		expect(delay).toBeGreaterThanOrEqual(0);
	});

	it("keeps rooms independent", () => {
		const flush = vi.fn();
		const manual = manualInboundScheduler();
		const s = createInboundScheduler({ flush, scheduler: manual.scheduler });
		s.enqueue("a", ir("a1"), undefined);
		s.enqueue("b", ir("b1"), undefined);
		manual.flush();
		expect(flush).toHaveBeenCalledTimes(2);
		const rooms = flush.mock.calls.map((c) => c[0]).sort();
		expect(rooms).toEqual(["a", "b"]);
	});

	it("flushNow drains synchronously and destroy cancels a pending frame", () => {
		const flush = vi.fn();
		const manual = manualInboundScheduler();
		const s = createInboundScheduler({ flush, scheduler: manual.scheduler });

		s.enqueue("default", ir("x"), undefined);
		s.flushNow();
		expect(flush).toHaveBeenCalledTimes(1);

		s.enqueue("default", ir("y"), undefined);
		expect(manual.pending()).toBeGreaterThan(0);
		s.destroy();
		manual.flush(); // frame fires after destroy — must be a no-op
		expect(flush).toHaveBeenCalledTimes(1);
		// Enqueue after destroy is ignored.
		s.enqueue("default", ir("z"), undefined);
		s.flushNow();
		expect(flush).toHaveBeenCalledTimes(1);
	});
});

describe("createInboundScheduler default scheduler — rAF failsafe (I4)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("flushes via the wall-clock timeout when rAF is parked", () => {
		vi.useFakeTimers();
		// rAF that NEVER invokes its callback (parked tab).
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn(() => 1),
		);
		vi.stubGlobal("cancelAnimationFrame", vi.fn());

		const flush = vi.fn();
		// No `scheduler` injected → exercises defaultScheduler.
		const s = createInboundScheduler({ flush });
		s.enqueue("default", ir("x"), { id: "p" });

		expect(flush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(249);
		expect(flush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1); // hit max(16, 250) = 250ms failsafe
		expect(flush).toHaveBeenCalledTimes(1);
		expect((flush.mock.calls[0]![1] as PageIR).root.id).toBe("x");
		s.destroy();
	});

	it("does not double-flush when rAF fires before the failsafe", () => {
		vi.useFakeTimers();
		let rafCb: (() => void) | undefined;
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((cb: () => void) => {
				rafCb = cb;
				return 7;
			}),
		);
		const caf = vi.fn();
		vi.stubGlobal("cancelAnimationFrame", caf);

		const flush = vi.fn();
		const s = createInboundScheduler({ flush });
		s.enqueue("default", ir("y"), undefined);

		rafCb?.(); // rAF wins the race
		expect(flush).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5000); // failsafe timer must have been cleared
		expect(flush).toHaveBeenCalledTimes(1);
		s.destroy();
	});

	it("destroy() cancels both the rAF and the failsafe timer", () => {
		vi.useFakeTimers();
		let rafCb: (() => void) | undefined;
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((cb: () => void) => {
				rafCb = cb;
				return 9;
			}),
		);
		const caf = vi.fn();
		vi.stubGlobal("cancelAnimationFrame", caf);

		const flush = vi.fn();
		const s = createInboundScheduler({ flush });
		s.enqueue("default", ir("z"), undefined);
		s.destroy();

		expect(caf).toHaveBeenCalledWith(9); // rAF handle cancelled
		vi.advanceTimersByTime(5000); // failsafe timer cancelled → no flush
		rafCb?.(); // a late frame after destroy must be a no-op
		expect(flush).not.toHaveBeenCalled();
	});
});
