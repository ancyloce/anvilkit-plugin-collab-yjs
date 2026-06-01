import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { Doc as YDoc } from "yjs";

import {
	createManagedTransport,
	mapHocuspocusStatus,
	mapProviderStatus,
} from "../transport.js";
import type { ConnectionStatus } from "../types/types.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

/**
 * Minimal WebSocket stub that never opens — lets us drive the real
 * y-websocket provider's construction/teardown without a network or a
 * connected socket, so no status ever advances past `connecting`.
 */
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

describe("createManagedTransport — construction", () => {
	it("creates a Y.Doc and Awareness synchronously, bound to the same doc", () => {
		const transport = createManagedTransport({});
		expect(transport.doc).toBeInstanceOf(YDoc);
		expect(transport.awareness).toBeInstanceOf(Awareness);
		expect(transport.awareness.doc).toBe(transport.doc);
		transport.destroy();
	});

	it("reuses a BYO awareness and does NOT destroy it on transport.destroy()", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const spy = vi.spyOn(awareness, "destroy");
		const transport = createManagedTransport({ awareness });
		expect(transport.awareness).toBe(awareness);
		transport.destroy();
		expect(spy).not.toHaveBeenCalled();
		awareness.destroy();
		doc.destroy();
	});

	it("destroys an owned awareness on transport.destroy()", () => {
		const transport = createManagedTransport({});
		const spy = vi.spyOn(transport.awareness, "destroy");
		transport.destroy();
		// Called at least once (directly, and again via the doc's "destroy"
		// event listener that y-protocols' Awareness registers — idempotent).
		expect(spy).toHaveBeenCalled();
	});
});

describe("createManagedTransport — connectionSource modes", () => {
	it("in-memory (no websocketUrl) exposes NO connectionSource", () => {
		// The adapter auto-flips connecting→synced on first subscribe; emitting
		// `synced` synchronously from a source would TDZ-crash adapter
		// construction (regression: P0-1).
		const transport = createManagedTransport({});
		expect(transport.connectionSource).toBeUndefined();
		transport.destroy();
	});

	it("in-memory transport drives a REAL adapter without a construction-time crash (P0-1 regression)", () => {
		const transport = createManagedTransport({});
		// Must NOT throw: a synchronous `synced` emit used to hit a `snapshots`
		// temporal-dead-zone inside createYjsAdapter and crash <Studio> mount.
		const adapter = createYjsAdapter({
			doc: transport.doc,
			awareness: transport.awareness,
			connectionSource: transport.connectionSource,
		});
		expect(adapter.getStatus().kind).toBe("connecting");
		// No connectionSource wired → auto-flip to synced on first subscribe.
		const unsubscribe = adapter.subscribe(() => undefined);
		expect(adapter.getStatus().kind).toBe("synced");
		unsubscribe();
		adapter.destroy();
		transport.destroy();
	});

	it("rejects an http:// URL through the status channel without throwing", () => {
		const onConnectionError = vi.fn();
		const transport = createManagedTransport({
			websocketUrl: "http://localhost:1234",
			onConnectionError,
		});
		const seen: ConnectionStatus[] = [];
		expect(() => transport.connectionSource((s) => seen.push(s))).not.toThrow();
		expect(seen[0]).toEqual({ kind: "connecting" });
		const last = seen.at(-1);
		expect(last?.kind).toBe("error");
		if (last?.kind === "error") expect(last.recoverable).toBe(false);
		expect(onConnectionError).toHaveBeenCalledTimes(1);
		transport.destroy();
	});

	it("rejects a malformed URL through the status channel", () => {
		const transport = createManagedTransport({ websocketUrl: "not a url" });
		const seen: ConnectionStatus[] = [];
		transport.connectionSource((s) => seen.push(s));
		expect(seen.at(-1)?.kind).toBe("error");
		transport.destroy();
	});

	it("starts a valid relay in `connecting` and never advances while the socket stays closed", async () => {
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "y-websocket",
			WebSocketPolyfill: NeverOpenWebSocket,
		});
		const seen: ConnectionStatus[] = [];
		const detach = transport.connectionSource((s) => seen.push(s));
		await new Promise((r) => setTimeout(r, 40));
		expect(seen.every((s) => s.kind === "connecting")).toBe(true);
		detach();
		transport.destroy();
	});

	it("disposed-before-attach: destroy() before the provider import resolves emits nothing past `connecting` and never throws", async () => {
		const transport = createManagedTransport({
			websocketUrl: "ws://localhost:65000/x",
			provider: "y-websocket",
			WebSocketPolyfill: NeverOpenWebSocket,
		});
		const seen: ConnectionStatus[] = [];
		const detach = transport.connectionSource((s) => seen.push(s));
		// Tear down synchronously, before `await import("y-websocket")` resolves.
		expect(() => transport.destroy()).not.toThrow();
		detach();
		await new Promise((r) => setTimeout(r, 40));
		expect(seen.every((s) => s.kind === "connecting")).toBe(true);
		expect(seen.some((s) => s.kind === "synced")).toBe(false);
	});
});

describe("status mapping (promoted verbatim)", () => {
	it("mapHocuspocusStatus covers connected/connecting/disconnected/default", () => {
		expect(mapHocuspocusStatus("connected").kind).toBe("synced");
		expect(mapHocuspocusStatus("connecting")).toEqual({ kind: "connecting" });
		expect(mapHocuspocusStatus("disconnected")).toMatchObject({
			kind: "offline",
			queuedEdits: 0,
		});
		expect(mapHocuspocusStatus("whatever")).toEqual({
			kind: "reconnecting",
			attempt: 1,
			backoffMs: 250,
		});
	});

	it("mapProviderStatus passes queuedEdits through on offline", () => {
		expect(mapProviderStatus("connected", 0).kind).toBe("synced");
		expect(mapProviderStatus("connecting", 0)).toEqual({ kind: "connecting" });
		expect(mapProviderStatus("disconnected", 7)).toMatchObject({
			kind: "offline",
			queuedEdits: 7,
		});
		expect(mapProviderStatus("???", 0)).toEqual({
			kind: "reconnecting",
			attempt: 1,
			backoffMs: 250,
		});
	});
});
