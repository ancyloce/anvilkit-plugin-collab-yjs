/**
 * @file Tests for the configurable logging hook (Report 0006 §4.3.2).
 *
 * Two library-level diagnostics previously went straight to the console:
 *   1. The deprecated `createCollabPlugin` alias one-shot `console.warn`.
 *   2. The default managed-transport error reporter's `console.error`.
 *
 * Both now route through an optional `logger` hook when one is supplied on
 * the relevant options contract. When NO logger is provided the console
 * fallback is preserved unchanged, so existing callers see no difference.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManagedTransport } from "../transport.js";

function fakeAdapter(): SnapshotAdapter {
	let saved = createFakePageIR();
	const snapshots: SnapshotMeta[] = [];
	return {
		save(ir) {
			saved = ir as typeof saved;
			const meta: SnapshotMeta = {
				id: `id-${snapshots.length}`,
				savedAt: new Date(snapshots.length).toISOString(),
				pageIRHash: `hash-${snapshots.length}`,
			};
			snapshots.push(meta);
			return meta.id;
		},
		list() {
			return snapshots;
		},
		load() {
			return saved;
		},
		subscribe(_onUpdate) {
			return () => undefined;
		},
	};
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	warnSpy.mockRestore();
	errorSpy.mockRestore();
});

describe("logger hook — deprecated createCollabPlugin alias", () => {
	it("routes the deprecation warning through logger and SKIPS console.warn when a logger is provided", async () => {
		// Fresh module instance so the warn-once flag is back to false.
		vi.resetModules();
		const fresh = (await import(
			"../plugin.js"
		)) as typeof import("../plugin.js");

		const logger = vi.fn();
		fresh.createCollabPlugin({ adapter: fakeAdapter(), logger });

		expect(logger).toHaveBeenCalledTimes(1);
		const [level, message] = logger.mock.calls[0] ?? [];
		expect(level).toBe("warn");
		expect(message).toContain("createCollabPlugin");
		expect(message).toContain("createCollabDataPlugin");
		expect(message).toContain("deprecated");
		// Console fallback MUST NOT fire when the logger handled it.
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("falls back to console.warn when NO logger is provided (default behavior unchanged)", async () => {
		vi.resetModules();
		const fresh = (await import(
			"../plugin.js"
		)) as typeof import("../plugin.js");

		fresh.createCollabPlugin({ adapter: fakeAdapter() });

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toContain("createCollabPlugin");
	});
});

describe("logger hook — managed transport error reporter", () => {
	it("routes the transport error through logger and SKIPS console.error when a logger is provided", () => {
		const logger = vi.fn();
		// An http:// URL fails protocol validation, firing the default error
		// reporter synchronously inside connectionSource().
		const transport = createManagedTransport({
			websocketUrl: "http://localhost:1234",
			logger,
		});
		transport.connectionSource?.(() => undefined);

		expect(logger).toHaveBeenCalledTimes(1);
		const [level, message, meta] = logger.mock.calls[0] ?? [];
		expect(level).toBe("error");
		expect(message).toBe("[anvilkit/collab] transport error:");
		expect(meta).toBeInstanceOf(Error);
		// Console fallback MUST NOT fire when the logger handled it.
		expect(errorSpy).not.toHaveBeenCalled();
		transport.destroy();
	});

	it("falls back to console.error when NO logger is provided (default behavior unchanged)", () => {
		const transport = createManagedTransport({
			websocketUrl: "http://localhost:1234",
		});
		transport.connectionSource?.(() => undefined);

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0]?.[0]).toBe(
			"[anvilkit/collab] transport error:",
		);
		transport.destroy();
	});

	it("does NOT fall back to logger when a custom onConnectionError is supplied", () => {
		const logger = vi.fn();
		const onConnectionError = vi.fn();
		const transport = createManagedTransport({
			websocketUrl: "http://localhost:1234",
			logger,
			onConnectionError,
		});
		transport.connectionSource?.(() => undefined);

		expect(onConnectionError).toHaveBeenCalledTimes(1);
		expect(logger).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		transport.destroy();
	});
});
