/**
 * @file Phase 3 (D6) — RBAC + lock policy bridge tests.
 *
 * `createCollabDataPlugin({ policy: { canEdit } })` is consulted on both
 * the inbound (remote → Puck dispatch) and outbound (Puck → adapter
 * save) paths. Rejections drop the dispatch/save and emit
 * `onPolicyViolation` with the touched node ids.
 */

import {
	createFakePageIR,
	createFakeStudioContext,
	registerPlugin,
} from "@anvilkit/core/testing";
import type {
	PageIR,
	PageIRNode,
	StudioPluginContext,
} from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import type {
	PeerInfo,
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";

import { createCollabDataPlugin } from "../plugin.js";
import type { PolicyViolation } from "../types.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

function fakeAdapter(): SnapshotAdapter & {
	pushUpdate: (
		ir?: ReturnType<typeof createFakePageIR>,
		peer?: PeerInfo,
	) => void;
	readonly savedIRs: ReturnType<typeof createFakePageIR>[];
} {
	let saved = createFakePageIR();
	let listener: ((ir: typeof saved, peer?: PeerInfo) => void) | undefined;
	const snapshots: SnapshotMeta[] = [];
	const savedIRs: ReturnType<typeof createFakePageIR>[] = [];
	return {
		savedIRs,
		save(ir) {
			saved = ir as typeof saved;
			savedIRs.push(saved);
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
		load(id) {
			if (snapshots.length > 0 && !snapshots.some((meta) => meta.id === id)) {
				throw new Error(`missing ${id}`);
			}
			return saved;
		},
		subscribe(onUpdate) {
			listener = onUpdate;
			return () => {
				listener = undefined;
			};
		},
		pushUpdate(ir, peer) {
			if (ir) saved = ir;
			listener?.(saved, peer);
		},
	};
}

function withLockedHero(headline: string, locked: boolean): PageIR {
	const ir = createFakePageIR();
	const hero: PageIRNode = {
		id: "hero-1",
		type: "Hero",
		props: { headline },
		meta: { locked },
	};
	return { ...ir, root: { ...ir.root, children: [hero] } };
}

describe("createCollabDataPlugin policy bridge (D6)", () => {
	it("inbound: drops dispatch when policy.canEdit returns false for any node", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const onPolicyViolation = vi.fn();
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				policy: {
					canEdit: (node) => !node.meta?.locked,
				},
				onPolicyViolation,
			}),
			{ ctx },
		);
		await harness.runInit();

		adapter.pushUpdate(withLockedHero("from remote", true), { id: "bob" });

		expect(dispatch).not.toHaveBeenCalled();
		expect(onPolicyViolation).toHaveBeenCalledTimes(1);
		const violation = onPolicyViolation.mock.calls[0]?.[0] as PolicyViolation;
		expect(violation.direction).toBe("inbound");
		expect(violation.nodeIds).toContain("hero-1");
		expect(violation.peer).toEqual({ id: "bob" });
	});

	it("inbound: lets the dispatch through when canEdit accepts every node", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				policy: { canEdit: () => true },
			}),
			{ ctx },
		);
		await harness.runInit();

		adapter.pushUpdate(withLockedHero("from remote", false), { id: "bob" });

		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("outbound: blocks save when policy.canEdit returns false for the local edit", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const onPolicyViolation = vi.fn();
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "alice" },
				// `meta.locked` does not survive `puckDataToIR` with a
				// stub config, so this test gates by id — equivalent for
				// the policy-bridge contract being asserted.
				policy: {
					canEdit: (node) => node.id !== "hero-1",
				},
				onPolicyViolation,
			}),
			{ ctx },
		);
		await harness.runInit();

		const lockedIR = withLockedHero("locally tried to edit", true);
		await harness.registration.hooks?.onDataChange?.(
			ctx,
			irToPuckData(lockedIR),
		);

		expect(adapter.savedIRs).toHaveLength(0);
		expect(onPolicyViolation).toHaveBeenCalledTimes(1);
		const violation = onPolicyViolation.mock.calls[0]?.[0] as PolicyViolation;
		expect(violation.direction).toBe("outbound");
		expect(violation.peer).toEqual({ id: "alice" });
		expect(violation.nodeIds).toContain("hero-1");
	});

	it("outbound: lets the save through when canEdit accepts every node", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				policy: { canEdit: () => true },
			}),
			{ ctx },
		);
		await harness.runInit();

		const ir = withLockedHero("not locked", false);
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(ir));

		expect(adapter.savedIRs).toHaveLength(1);
	});

	it("treats a synchronous canEdit throw as denial and surfaces the error", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const onPolicyViolation = vi.fn();
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				policy: {
					canEdit: () => {
						throw new Error("policy lookup failed");
					},
				},
				onPolicyViolation,
			}),
			{ ctx },
		);
		await harness.runInit();

		adapter.pushUpdate(createFakePageIR({ rootId: "root" }), { id: "bob" });

		expect(dispatch).not.toHaveBeenCalled();
		const violation = onPolicyViolation.mock.calls[0]?.[0] as PolicyViolation;
		expect(violation.direction).toBe("inbound");
		expect(violation.error).toBeInstanceOf(Error);
	});

	it("logs a structured warning naming the rejected node ids", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({
				adapter,
				policy: { canEdit: (node) => node.id !== "hero-1" },
			}),
			{ ctx },
		);
		await harness.runInit();

		adapter.pushUpdate(withLockedHero("hello", true), { id: "bob" });

		expect(ctx._mocks.logCalls).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					"warn",
					expect.stringContaining("blocked by policy.canEdit"),
				]),
			]),
		);
	});

	it("does NOT call canEdit at all when policy is omitted", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabDataPlugin({ adapter, puckConfig: STUB_CONFIG }),
			{ ctx },
		);
		await harness.runInit();

		const ir = withLockedHero("hello", true);
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(ir));
		adapter.pushUpdate(ir, { id: "bob" });

		expect(adapter.savedIRs).toHaveLength(1);
		expect(dispatch).toHaveBeenCalled();
	});
});
