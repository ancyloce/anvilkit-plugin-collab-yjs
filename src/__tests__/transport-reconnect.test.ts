import { describe, expect, it, vi } from "vitest";

import {
	createManagedTransport,
	createProviderStatusMapper,
	mapHocuspocusStatus,
} from "../transport.js";
import type { ConnectionStatus } from "../types/types.js";
import { createReconnectTracker } from "../utils/reconnect-tracker.js";

/**
 * §4.2.1 regression coverage: incremental reconnect attempt/backoff and the
 * connection-timeout escalation. These drive the REAL provider event handlers
 * (`attachHocuspocusProvider` / `attachYWebsocketProvider`) — not synthetic
 * `ConnectionStatus` emits — so they exercise the production mapping path.
 */

/** Reused FakeHocuspocusProvider pattern from `transport-auth.test.ts`. */
const { hocuspocusInstances, FakeHocuspocusProvider } = vi.hoisted(() => {
	type Handler = (payload: unknown) => void;
	class Fake {
		readonly listeners = new Map<string, Set<Handler>>();
		isSynced = false;
		configuration: { websocketProvider?: { status?: string } } = {
			websocketProvider: undefined,
		};
		destroyed = false;
		constructor(public readonly options: Record<string, unknown>) {
			instances.push(this);
		}
		on(event: string, handler: Handler): void {
			const set = this.listeners.get(event) ?? new Set<Handler>();
			set.add(handler);
			this.listeners.set(event, set);
		}
		off(event: string, handler: Handler): void {
			this.listeners.get(event)?.delete(handler);
		}
		emit(event: string, payload: unknown): void {
			for (const handler of this.listeners.get(event) ?? []) handler(payload);
		}
		destroy(): void {
			this.destroyed = true;
		}
	}
	const instances: Fake[] = [];
	return { hocuspocusInstances: instances, FakeHocuspocusProvider: Fake };
});

vi.mock("@hocuspocus/provider", () => ({
	HocuspocusProvider: FakeHocuspocusProvider,
}));

/** Minimal WebSocket stub that never opens (copy of transport.test.ts's stub). */
class NeverOpenWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = 0;
	binaryType = "arraybuffer";
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: unknown) => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	constructor(public url: string) {}
	send(): void {
		/* no-op: never connects */
	}
	close(): void {
		this.readyState = NeverOpenWebSocket.CLOSED;
		this.onclose?.({ code: 1000 });
	}
	addEventListener(): void {
		/* no-op */
	}
	removeEventListener(): void {
		/* no-op */
	}
}

type Reconnecting = Extract<ConnectionStatus, { kind: "reconnecting" }>;

describe("createReconnectTracker — jittered exponential backoff", () => {
	it("increments the attempt counter and grows the backoff, deterministically with an injected rng", () => {
		const tracker = createReconnectTracker({
			baseMs: 250,
			factor: 2,
			maxMs: 60_000,
			jitterRatio: 0.5,
			rng: () => 0.5,
		});
		const a = tracker.recordReconnect();
		const b = tracker.recordReconnect();
		const c = tracker.recordReconnect();
		expect([a.attempt, b.attempt, c.attempt]).toEqual([1, 2, 3]);
		// equal-jitter with rng()=0.5 → capped * 0.75: 250→188, 500→375, 1000→750
		expect([a.backoffMs, b.backoffMs, c.backoffMs]).toEqual([188, 375, 750]);
		expect(b.backoffMs).toBeGreaterThan(a.backoffMs);
		expect(c.backoffMs).toBeGreaterThan(b.backoffMs);
	});

	it("resets the attempt counter (and the backoff schedule) on reset()", () => {
		const tracker = createReconnectTracker({ rng: () => 0.5 });
		const first = tracker.recordReconnect();
		tracker.recordReconnect();
		tracker.reset();
		const afterReset = tracker.recordReconnect();
		expect(afterReset.attempt).toBe(1);
		expect(afterReset.backoffMs).toBe(first.backoffMs);
	});

	it("clamps the (pre-jitter) backoff to maxMs and keeps the jitter bounded", () => {
		const tracker = createReconnectTracker({
			baseMs: 1000,
			factor: 10,
			maxMs: 5000,
			jitterRatio: 0.5,
			rng: () => 0.999, // upper jitter bound
		});
		tracker.recordReconnect(); // 1000
		tracker.recordReconnect(); // 10000 → capped 5000
		const capped = tracker.recordReconnect(); // still capped 5000
		// upper bound: capped * (0.5 + 0.5*0.999) < capped
		expect(capped.backoffMs).toBeLessThanOrEqual(5000);
		expect(capped.backoffMs).toBeGreaterThan(2500);
	});
});

describe("createProviderStatusMapper — dropped→reconnect transitions", () => {
	const base = mapHocuspocusStatus;

	it("reports a fresh `connecting` as connecting, but a post-drop `connecting` as reconnecting", () => {
		const mapper = createProviderStatusMapper(
			base,
			createReconnectTracker({ rng: () => 0.5 }),
		);
		expect(mapper.map("connecting").kind).toBe("connecting");
		expect(mapper.map("connected").kind).toBe("synced");
		expect(mapper.map("disconnected").kind).toBe("offline");
		const r = mapper.map("connecting");
		expect(r.kind).toBe("reconnecting");
		if (r.kind === "reconnecting") expect(r.attempt).toBe(1);
	});

	it("increments across cycles and resets the counter on synced", () => {
		const mapper = createProviderStatusMapper(
			base,
			createReconnectTracker({ rng: () => 0.5 }),
		);
		const attempts: number[] = [];
		const record = (s: ConnectionStatus) => {
			if (s.kind === "reconnecting") attempts.push(s.attempt);
		};
		record(mapper.map("disconnected"));
		record(mapper.map("connecting")); // #1
		record(mapper.map("disconnected"));
		record(mapper.map("connecting")); // #2
		record(mapper.map("connected")); // reset
		record(mapper.map("disconnected"));
		record(mapper.map("connecting")); // #1 again
		expect(attempts).toEqual([1, 2, 1]);
	});

	it("noteSynced() resets and noteDropped() arms the next connecting as a reconnect", () => {
		const mapper = createProviderStatusMapper(
			base,
			createReconnectTracker({ rng: () => 0.5 }),
		);
		mapper.noteDropped();
		expect(mapper.map("connecting").kind).toBe("reconnecting");
		mapper.noteSynced();
		// After a side-channel sync, a fresh connecting is NOT a reconnect.
		expect(mapper.map("connecting").kind).toBe("connecting");
	});
});

describe("managed transport — incremental reconnect through the real provider", () => {
	it("maps disconnect→reconnect cycles to reconnecting with growing backoff that resets on synced", async () => {
		hocuspocusInstances.length = 0;
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "hocuspocus",
			// Disable the connect timeout so this test leaves no real timer.
			connectTimeoutMs: 0,
			reconnectBackoff: {
				baseMs: 250,
				factor: 2,
				maxMs: 60_000,
				jitterRatio: 0.5,
				rng: () => 0.5,
			},
		});
		const seen: ConnectionStatus[] = [];
		const detach = transport.connectionSource?.((s) => seen.push(s));
		await vi.waitFor(() => expect(hocuspocusInstances.length).toBe(1));
		const provider = hocuspocusInstances[0];

		// Drive the REAL `status` event the production handler subscribes to.
		provider.emit("status", { status: "connecting" }); // fresh connect
		provider.emit("status", { status: "connected" }); // synced
		provider.emit("status", { status: "disconnected" });
		provider.emit("status", { status: "connecting" }); // reconnect #1
		provider.emit("status", { status: "disconnected" });
		provider.emit("status", { status: "connecting" }); // reconnect #2
		provider.emit("status", { status: "disconnected" });
		provider.emit("status", { status: "connecting" }); // reconnect #3
		provider.emit("status", { status: "connected" }); // synced → reset
		provider.emit("status", { status: "disconnected" });
		provider.emit("status", { status: "connecting" }); // reconnect #1 again

		const reconnects = seen.filter(
			(s): s is Reconnecting => s.kind === "reconnecting",
		);
		expect(reconnects.map((r) => r.attempt)).toEqual([1, 2, 3, 1]);
		expect(reconnects.map((r) => r.backoffMs)).toEqual([188, 375, 750, 188]);
		expect(reconnects[1].backoffMs).toBeGreaterThan(reconnects[0].backoffMs);
		expect(reconnects[2].backoffMs).toBeGreaterThan(reconnects[1].backoffMs);
		// Reset proven: the post-resync attempt is back to the first backoff.
		expect(reconnects[3].backoffMs).toBe(reconnects[0].backoffMs);

		detach?.();
		transport.destroy();
	});
});

describe("managed transport — connection timeout (§4.2.1)", () => {
	it("surfaces a `reason: timeout` error when the socket never syncs within connectTimeoutMs", async () => {
		vi.useFakeTimers();
		try {
			const transport = createManagedTransport({
				websocketUrl: "ws://localhost:65000/x",
				provider: "y-websocket",
				WebSocketPolyfill: NeverOpenWebSocket,
				connectTimeoutMs: 2500,
			});
			const seen: ConnectionStatus[] = [];
			const detach = transport.connectionSource?.((s) => seen.push(s));
			// The connecting status arms the timer synchronously, from the real
			// connecting path — no synthetic emit.
			expect(seen[0]).toEqual({ kind: "connecting" });
			expect(seen.some((s) => s.kind === "error")).toBe(false);

			await vi.advanceTimersByTimeAsync(2500);

			const err = seen.find((s) => s.kind === "error");
			expect(err).toBeDefined();
			if (err?.kind === "error") {
				expect(err.reason).toBe("timeout");
				expect(err.recoverable).toBe(true);
				expect(err.message).toContain("2500ms");
			}

			detach?.();
			transport.destroy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT fire the timeout when connectTimeoutMs <= 0 (disabled)", async () => {
		vi.useFakeTimers();
		try {
			const transport = createManagedTransport({
				websocketUrl: "ws://localhost:65000/x",
				provider: "y-websocket",
				WebSocketPolyfill: NeverOpenWebSocket,
				connectTimeoutMs: 0,
			});
			const seen: ConnectionStatus[] = [];
			const detach = transport.connectionSource?.((s) => seen.push(s));
			await vi.advanceTimersByTimeAsync(10_000);
			expect(
				seen.some((s) => s.kind === "error" && s.reason === "timeout"),
			).toBe(false);
			detach?.();
			transport.destroy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the connect timeout once the provider syncs (no spurious timeout error)", async () => {
		hocuspocusInstances.length = 0;
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "hocuspocus",
			connectTimeoutMs: 120,
		});
		const seen: ConnectionStatus[] = [];
		const detach = transport.connectionSource?.((s) => seen.push(s));
		// Let the (mocked) provider import + attach resolve well within the
		// 120ms timeout window, then reach synced before it elapses.
		await new Promise((r) => setTimeout(r, 10));
		expect(hocuspocusInstances.length).toBe(1);
		hocuspocusInstances[0].emit("synced", {});
		// Wait past the original timeout window: an uncleared timer fires by now.
		await new Promise((r) => setTimeout(r, 200));
		expect(seen.some((s) => s.kind === "error" && s.reason === "timeout")).toBe(
			false,
		);
		expect(seen.some((s) => s.kind === "synced")).toBe(true);
		detach?.();
		transport.destroy();
	});
});
