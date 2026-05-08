import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import type { ConnectionSource, ConnectionStatus } from "../types.js";
import { createYjsAdapter } from "../yjs-adapter.js";

describe("createYjsAdapter onStatusChange / connectionSource", () => {
	it("starts in `connecting` and exposes the current status synchronously", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		expect(adapter.getStatus()).toEqual({ kind: "connecting" });
	});

	it("flips to `synced` on first subscribe when no connectionSource is wired", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const seen: ConnectionStatus[] = [];
		adapter.onStatusChange((s) => seen.push(s));

		expect(seen).toEqual([{ kind: "connecting" }]);
		const unsubscribe = adapter.subscribe(() => undefined);

		expect(seen.at(-1)?.kind).toBe("synced");
		unsubscribe();
	});

	it("invokes the callback synchronously with the current status on registration", () => {
		const adapter = createYjsAdapter({ doc: new YDoc() });
		const seen: ConnectionStatus[] = [];
		const unsub = adapter.onStatusChange((s) => seen.push(s));
		expect(seen).toEqual([{ kind: "connecting" }]);
		unsub();
	});

	it("forwards every status emitted by the connectionSource", () => {
		let drive: (status: ConnectionStatus) => void = () => undefined;
		const source: ConnectionSource = (emit) => {
			drive = emit;
			return () => undefined;
		};
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			connectionSource: source,
		});

		const seen: ConnectionStatus[] = [];
		adapter.onStatusChange((s) => seen.push(s));

		drive({ kind: "synced", since: "2026-05-08T00:00:00Z" });
		drive({
			kind: "offline",
			since: "2026-05-08T00:00:30Z",
			queuedEdits: 3,
		});
		drive({ kind: "reconnecting", attempt: 1, backoffMs: 250 });
		drive({ kind: "error", message: "auth", recoverable: false });

		const kinds = seen.map((s) => s.kind);
		expect(kinds).toEqual([
			"connecting",
			"synced",
			"offline",
			"reconnecting",
			"error",
		]);
		expect(adapter.getStatus()).toEqual({
			kind: "error",
			message: "auth",
			recoverable: false,
		});
	});

	it("does NOT auto-flip to `synced` on subscribe when a connectionSource is wired", () => {
		const source: ConnectionSource = () => () => undefined;
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			connectionSource: source,
		});

		const unsub = adapter.subscribe(() => undefined);
		expect(adapter.getStatus()).toEqual({ kind: "connecting" });
		unsub();
	});

	it("unsubscribes status listeners cleanly", () => {
		let drive: (status: ConnectionStatus) => void = () => undefined;
		const source: ConnectionSource = (emit) => {
			drive = emit;
			return () => undefined;
		};
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			connectionSource: source,
		});

		let count = 0;
		const unsub = adapter.onStatusChange(() => {
			count += 1;
		});
		drive({ kind: "synced", since: "now" });
		expect(count).toBe(2); // initial + drive

		unsub();
		drive({ kind: "offline", since: "now", queuedEdits: 0 });
		expect(count).toBe(2);
	});

	it("destroy() releases the connectionSource subscription", () => {
		let unsubCount = 0;
		const source: ConnectionSource = () => {
			return () => {
				unsubCount += 1;
			};
		};
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			connectionSource: source,
		});

		adapter.destroy();
		expect(unsubCount).toBe(1);
	});

	it("listener errors do not break sibling listeners", () => {
		let drive: (status: ConnectionStatus) => void = () => undefined;
		const source: ConnectionSource = (emit) => {
			drive = emit;
			return () => undefined;
		};
		const adapter = createYjsAdapter({
			doc: new YDoc(),
			connectionSource: source,
		});

		adapter.onStatusChange(() => {
			throw new Error("listener boom");
		});
		const seen: ConnectionStatus[] = [];
		adapter.onStatusChange((s) => seen.push(s));

		drive({ kind: "synced", since: "t" });
		expect(seen.length).toBe(2);
	});
});
