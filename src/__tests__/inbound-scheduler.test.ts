import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it, vi } from "vitest";

import { createInboundScheduler } from "../inbound-scheduler.js";
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
