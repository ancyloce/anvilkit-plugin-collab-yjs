/**
 * @file L5 — BroadcastChannel bridge tests. Verifies same-origin
 * cross-tab Y.js update relay, instance-id echo guard, and graceful
 * fallback when BroadcastChannel is unavailable.
 */

import { describe, expect, it, vi } from "vitest";

import { createBroadcastBridge } from "../persistence/broadcast-channel.js";

const TEST_CHANNEL = "anvilkit-collab-yjs:test-channel";

describe("createBroadcastBridge (L5)", () => {
	it("delivers updates between two bridges on the same channel", async () => {
		const a = createBroadcastBridge({ channelName: TEST_CHANNEL });
		const b = createBroadcastBridge({ channelName: TEST_CHANNEL });
		const received: Uint8Array[] = [];

		b.onRemoteUpdate((u) => received.push(u));

		const payload = new Uint8Array([1, 2, 3, 4]);
		a.postUpdate(payload);

		// BroadcastChannel delivery is asynchronous via microtask + I/O.
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(received).toHaveLength(1);
		expect(Array.from(received[0]!)).toEqual([1, 2, 3, 4]);

		a.destroy();
		b.destroy();
	});

	it("drops messages tagged with its own instanceId (echo guard)", async () => {
		const a = createBroadcastBridge({ channelName: TEST_CHANNEL });
		const received: Uint8Array[] = [];
		a.onRemoteUpdate((u) => received.push(u));

		// Self-post: BroadcastChannel spec says we don't receive our own,
		// but the echo guard is defense-in-depth for polyfills and Node
		// runtimes that do echo locally.
		a.postUpdate(new Uint8Array([9, 9, 9]));

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(received).toHaveLength(0);

		a.destroy();
	});

	it("isolates traffic between two different channel names", async () => {
		const a = createBroadcastBridge({ channelName: `${TEST_CHANNEL}:room-a` });
		const b = createBroadcastBridge({ channelName: `${TEST_CHANNEL}:room-b` });
		const received: Uint8Array[] = [];
		b.onRemoteUpdate((u) => received.push(u));

		a.postUpdate(new Uint8Array([1]));
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(received).toHaveLength(0);
		a.destroy();
		b.destroy();
	});

	it("`destroy()` unsubscribes future remote updates", async () => {
		const a = createBroadcastBridge({ channelName: TEST_CHANNEL });
		const b = createBroadcastBridge({ channelName: TEST_CHANNEL });
		const received: Uint8Array[] = [];
		b.onRemoteUpdate((u) => received.push(u));

		b.destroy();
		a.postUpdate(new Uint8Array([42]));

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(received).toHaveLength(0);
		a.destroy();
	});

	it("falls back to a no-op bridge when BroadcastChannel is unavailable", () => {
		const original = (globalThis as { BroadcastChannel?: unknown })
			.BroadcastChannel;
		(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
		const onFault = vi.fn();
		try {
			const bridge = createBroadcastBridge({
				channelName: TEST_CHANNEL,
				onFault,
			});
			expect(onFault).toHaveBeenCalledWith("broadcast-channel-unavailable");
			// no-op bridge: posting and subscribing must not throw.
			expect(() => bridge.postUpdate(new Uint8Array([1]))).not.toThrow();
			expect(
				typeof bridge.onRemoteUpdate(() => {
					// no-op test handler
				}),
			).toBe("function");
			bridge.destroy();
		} finally {
			(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
				original;
		}
	});
});
