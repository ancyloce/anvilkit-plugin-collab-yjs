/**
 * @file PLAN-0025 P3.5-05 root-cause fix — empty-room seeding.
 *
 * A peer that mounts into a room with NO stored snapshot must persist
 * the editor's current document through the normal save path, so the
 * conflict window's baseline anchor exists before the user's first
 * keystroke (see `seedEmptyRoom` in `plugin.ts` and the phase
 * diagnostic `docs/reports/phase-3.5-diagnostic-P3.5-05-0805-1030.md`).
 */

import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type { StudioPluginContext } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import type { PeerInfo, SnapshotMeta } from "@anvilkit/plugin-version-history";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";
import { createCollabPlugin as baseCollabPlugin } from "../plugin.js";
import type { CreateCollabPluginOptions } from "../types/types.js";
import { syncInboundScheduler } from "./helpers/inbound.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

const createCollabPlugin = (o: CreateCollabPluginOptions) =>
	baseCollabPlugin({
		...o,
		inboundScheduler: o.inboundScheduler ?? syncInboundScheduler(),
	});

function fakeAdapter(preSeeded = false) {
	let saved = createFakePageIR();
	const snapshots: SnapshotMeta[] = [];
	const savedIRs: ReturnType<typeof createFakePageIR>[] = [];
	if (preSeeded) {
		snapshots.push({
			id: "pre-0",
			savedAt: new Date(0).toISOString(),
			pageIRHash: "pre-hash",
		});
	}
	return {
		savedIRs,
		save(ir: typeof saved) {
			saved = ir;
			savedIRs.push(saved);
			const meta: SnapshotMeta = {
				id: `id-${snapshots.length}`,
				savedAt: new Date(snapshots.length + 1).toISOString(),
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
		subscribe(_onUpdate: (ir: typeof saved, peer?: PeerInfo) => void) {
			return () => {
				/* no-op */
			};
		},
	};
}

function ctxWith(data: unknown): StudioPluginContext {
	return createFakeStudioContext({
		getData: (() => data) as StudioPluginContext["getData"],
		getPuckApi: vi.fn(
			() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
		) as unknown as StudioPluginContext["getPuckApi"],
	});
}

describe("empty-room seeding (P3.5-05 fix)", () => {
	it("seeds an empty room with the editor's current document", async () => {
		const adapter = fakeAdapter();
		const documentIR = createFakePageIR({ rootId: "seed-root" });
		const ctx = ctxWith(irToPuckData(documentIR));

		const harness = await registerPlugin(
			createCollabPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "local-test" },
			}),
			{ ctx },
		);
		await harness.runInit();

		expect(adapter.savedIRs.length).toBe(1);
	});

	it("does NOT seed when the room already holds a snapshot (hydrate wins)", async () => {
		const adapter = fakeAdapter(true);
		const documentIR = createFakePageIR({ rootId: "local-root" });
		const ctx = ctxWith(irToPuckData(documentIR));

		const harness = await registerPlugin(
			createCollabPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "local-test" },
			}),
			{ ctx },
		);
		await harness.runInit();

		expect(adapter.savedIRs.length).toBe(0);
	});

	it("does NOT seed a genuinely empty editor (legacy first-save semantics kept)", async () => {
		const adapter = fakeAdapter();
		const ctx = ctxWith({ content: [], root: { props: {} }, zones: {} });

		const harness = await registerPlugin(
			createCollabPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "local-test" },
			}),
			{ ctx },
		);
		await harness.runInit();

		expect(adapter.savedIRs.length).toBe(0);
	});
});
