import { describe, expect, it, vi } from "vitest";

import { createManagedTransport } from "../transport.js";
import type { ConnectionStatus } from "../types/types.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

/**
 * Fake `@hocuspocus/provider` so we can drive the provider's real
 * `authenticationFailed` event without a live relay. We capture every
 * constructed instance so a test can fire the same event name the
 * production `attachHocuspocusProvider` subscribes to (NOT a synthetic
 * `ConnectionStatus` — the assertion exercises the real auth-failed path).
 */
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

describe("Hocuspocus auth/permission failure mapping", () => {
	it("maps a Hocuspocus authenticationFailed event to a typed `auth` error reason that is non-recoverable", async () => {
		hocuspocusInstances.length = 0;
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "hocuspocus",
			token: "bad-token",
		});
		const seen: ConnectionStatus[] = [];
		const source = transport.connectionSource;
		expect(source).toBeDefined();
		const detach = source?.((s) => seen.push(s));

		// Wait for `await import("@hocuspocus/provider")` to resolve + attach.
		await vi.waitFor(() => expect(hocuspocusInstances.length).toBe(1));
		const provider = hocuspocusInstances[0];

		// Fire the REAL provider event the production handler subscribes to.
		provider.emit("authenticationFailed", { reason: "Invalid token" });

		const last = seen.at(-1);
		expect(last?.kind).toBe("error");
		if (last?.kind === "error") {
			// Distinguishable from a generic transport error.
			expect(last.reason).toBe("auth");
			// Auth failures are non-recoverable without new credentials.
			expect(last.recoverable).toBe(false);
			expect(last.message).toContain("Invalid token");
		}

		detach?.();
		transport.destroy();
	});

	it("tags a generic Hocuspocus disconnect/offline transition as a non-`auth` reason", async () => {
		hocuspocusInstances.length = 0;
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "hocuspocus",
		});
		const seen: ConnectionStatus[] = [];
		const detach = transport.connectionSource?.((s) => seen.push(s));

		await vi.waitFor(() => expect(hocuspocusInstances.length).toBe(1));
		const provider = hocuspocusInstances[0];
		provider.emit("disconnect", {});

		// A disconnect is NOT an error at all — proving we did not conflate a
		// transport-level drop with an auth failure.
		expect(seen.some((s) => s.kind === "error")).toBe(false);
		expect(seen.at(-1)?.kind).toBe("offline");

		detach?.();
		transport.destroy();
	});

	it("propagates the `auth` reason end-to-end through a real adapter's getStatus/onStatusChange", async () => {
		hocuspocusInstances.length = 0;
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "hocuspocus",
			token: "expired",
		});
		const adapter = createYjsAdapter({
			doc: transport.doc,
			awareness: transport.awareness,
			connectionSource: transport.connectionSource,
		});
		const seen: ConnectionStatus[] = [];
		const unsubscribe = adapter.onStatusChange((s) => seen.push(s));

		await vi.waitFor(() => expect(hocuspocusInstances.length).toBe(1));
		hocuspocusInstances[0].emit("authenticationFailed", { reason: "expired" });

		// The adapter FSM must pass the typed auth error through verbatim — the
		// reason discriminator and the recoverable flag both survive.
		const status = adapter.getStatus();
		expect(status.kind).toBe("error");
		if (status.kind === "error") {
			expect(status.reason).toBe("auth");
			expect(status.recoverable).toBe(false);
		}
		const lastBroadcast = seen.at(-1);
		expect(lastBroadcast?.kind).toBe("error");
		if (lastBroadcast?.kind === "error") {
			expect(lastBroadcast.reason).toBe("auth");
		}

		unsubscribe();
		adapter.destroy();
		transport.destroy();
	});
});
