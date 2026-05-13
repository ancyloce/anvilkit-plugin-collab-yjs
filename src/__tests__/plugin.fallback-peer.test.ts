import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { StudioPluginContext } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import type {
	PeerInfo,
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";

import { createCollabPlugin } from "../plugin.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

function fakeAdapter() {
	const snapshots: SnapshotMeta[] = [];
	return {
		save() {
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
			return createFakePageIR();
		},
		subscribe(
			_onUpdate: (
				ir: ReturnType<typeof createFakePageIR>,
				peer?: PeerInfo,
			) => void,
		) {
			return () => undefined;
		},
	} satisfies SnapshotAdapter;
}

describe("createCollabPlugin fallback peer (H2)", () => {
	it("emits a one-time warn log when options.localPeer is omitted", async () => {
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabPlugin({ adapter: fakeAdapter(), puckConfig: STUB_CONFIG }),
			{ ctx },
		);
		await harness.runInit();

		const warns = ctx._mocks.logCalls.filter(
			(call) =>
				call[0] === "warn" &&
				typeof call[1] === "string" &&
				call[1].includes("options.localPeer omitted"),
		);
		expect(warns).toHaveLength(1);
	});

	it("does NOT emit the warn log when options.localPeer is provided", async () => {
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabPlugin({
				adapter: fakeAdapter(),
				puckConfig: STUB_CONFIG,
				localPeer: { id: "explicit-peer" },
			}),
			{ ctx },
		);
		await harness.runInit();

		const warns = ctx._mocks.logCalls.filter(
			(call) =>
				call[0] === "warn" &&
				typeof call[1] === "string" &&
				call[1].includes("options.localPeer omitted"),
		);
		expect(warns).toHaveLength(0);
	});

	it("generates DISTINCT ephemeral peer ids for separate plugin instances", async () => {
		const ctxA = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const ctxB = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harnessA = await registerPlugin(
			createCollabPlugin({ adapter: fakeAdapter(), puckConfig: STUB_CONFIG }),
			{ ctx: ctxA },
		);
		const harnessB = await registerPlugin(
			createCollabPlugin({ adapter: fakeAdapter(), puckConfig: STUB_CONFIG }),
			{ ctx: ctxB },
		);
		await harnessA.runInit();
		await harnessB.runInit();

		const idA = (
			ctxA._mocks.logCalls.find(
				(call) =>
					call[0] === "warn" &&
					typeof call[1] === "string" &&
					call[1].includes("options.localPeer omitted"),
			)?.[2] as { id: string }
		).id;
		const idB = (
			ctxB._mocks.logCalls.find(
				(call) =>
					call[0] === "warn" &&
					typeof call[1] === "string" &&
					call[1].includes("options.localPeer omitted"),
			)?.[2] as { id: string }
		).id;

		expect(idA).toMatch(/^local-/);
		expect(idB).toMatch(/^local-/);
		expect(idA).not.toBe(idB);
	});
});
