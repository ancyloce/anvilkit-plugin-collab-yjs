import { describe, expect, it, vi } from "vitest";

import { createManagedTransport } from "../transport.js";
import type { ConnectionStatus } from "../types/types.js";

// Simulate the optional peer not being installed: the dynamic import
// resolves to a module with no `WebsocketProvider` export, so constructing
// it throws inside the transport's `connectionSource` async attach.
vi.mock("y-websocket", () => ({}));

describe("createManagedTransport — provider not installed", () => {
	it("emits a recoverable:false `error` and calls onConnectionError, never throwing", async () => {
		const onConnectionError = vi.fn();
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "y-websocket",
			onConnectionError,
		});
		const seen: ConnectionStatus[] = [];
		expect(() => transport.connectionSource((s) => seen.push(s))).not.toThrow();

		await vi.waitFor(() => {
			expect(seen.at(-1)?.kind).toBe("error");
		});

		const last = seen.at(-1);
		expect(last?.kind).toBe("error");
		if (last?.kind === "error") {
			expect(last.message).toContain("is not installed");
			expect(last.recoverable).toBe(false);
		}
		expect(onConnectionError).toHaveBeenCalledTimes(1);
		transport.destroy();
	});
});
