/**
 * @file Tests for the deprecated `createCollabPlugin` alias.
 *
 * The factory was renamed `createCollabDataPlugin` (task_013) because
 * `@anvilkit/plugin-collab-ui` will export a higher-level
 * `createCollabPlugin` that bundles the data plugin with UI
 * contributions. The legacy alias stays available for one minor
 * release with a one-shot deprecation `console.warn` on first call.
 *
 * Tests cover:
 *   1. The alias returns a plugin that is functionally equivalent to
 *      what `createCollabDataPlugin` returns (same `meta`).
 *   2. The deprecation warning fires exactly once per module instance
 *      no matter how many times the alias is invoked.
 *   3. A fresh module instance (via `vi.resetModules()` + dynamic
 *      import) re-arms the one-shot warning — the flag is module-scoped,
 *      not global.
 */

import {
	createFakePageIR,
	createFakeStudioContext,
} from "@anvilkit/core/testing";
import { compilePlugins } from "@anvilkit/core";
import type {
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCollabDataPlugin, createCollabPlugin } from "../plugin.js";

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

beforeEach(() => {
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	warnSpy.mockRestore();
});

describe("createCollabPlugin (deprecated alias)", () => {
	it("returns a plugin functionally equivalent to createCollabDataPlugin", async () => {
		const adapter = fakeAdapter();
		const legacy = createCollabPlugin({ adapter });
		const current = createCollabDataPlugin({ adapter });
		// Same plugin meta — alias only adds the deprecation side-effect,
		// not a different registration shape.
		expect(legacy.meta).toEqual(current.meta);
		// Both compile through compilePlugins() without throwing.
		const runtime = await compilePlugins([legacy], createFakeStudioContext());
		expect(runtime.pluginMeta).toHaveLength(1);
		expect(runtime.pluginMeta[0]?.id).toBe(current.meta.id);
	});

	it("emits the deprecation warning exactly once across multiple calls in the same module instance", async () => {
		// Use a fresh module instance so the prior test's call doesn't
		// affect the warn-once flag.
		vi.resetModules();
		const fresh = (await import(
			"../plugin.js"
		)) as typeof import("../plugin.js");

		fresh.createCollabPlugin({ adapter: fakeAdapter() });
		fresh.createCollabPlugin({ adapter: fakeAdapter() });
		fresh.createCollabPlugin({ adapter: fakeAdapter() });

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [firstCall] = warnSpy.mock.calls;
		expect(firstCall?.[0]).toContain("createCollabPlugin");
		expect(firstCall?.[0]).toContain("createCollabDataPlugin");
		expect(firstCall?.[0]).toContain("deprecated");
	});

	it("re-arms the warning when the module is freshly imported (flag is module-scoped, not global)", async () => {
		// First instance — warn fires.
		vi.resetModules();
		const first = (await import(
			"../plugin.js"
		)) as typeof import("../plugin.js");
		first.createCollabPlugin({ adapter: fakeAdapter() });
		expect(warnSpy).toHaveBeenCalledTimes(1);

		// Second instance — warn fires again because the flag belongs
		// to the freshly-loaded module, not the global scope.
		vi.resetModules();
		const second = (await import(
			"../plugin.js"
		)) as typeof import("../plugin.js");
		second.createCollabPlugin({ adapter: fakeAdapter() });
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});
});
