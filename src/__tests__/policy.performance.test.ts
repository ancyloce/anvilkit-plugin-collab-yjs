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
	SnapshotAdapter,
	SnapshotMeta,
} from "@anvilkit/plugin-version-history";
import type { Config, PuckApi } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";

import { createCollabPlugin } from "../plugin.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

function fakeAdapter(): SnapshotAdapter {
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
	};
}

function deepIR(): PageIR {
	const ir = createFakePageIR();
	// Build a tree with several siblings sharing the same id to verify
	// the memoization deduplicates. We also nest to confirm walkNodes
	// covers the whole tree.
	const child: PageIRNode = { id: "leaf", type: "Hero", props: {} };
	return {
		...ir,
		root: {
			...ir.root,
			children: [
				{ id: "branch", type: "Hero", props: {}, children: [child, child] },
			],
		},
	};
}

describe("enforcePolicy memoization (M5)", () => {
	it("calls canEdit once per unique (node, peer) within a single enforcement pass", async () => {
		const canEdit = vi.fn(() => true);
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabPlugin({
				adapter: fakeAdapter(),
				puckConfig: STUB_CONFIG,
				policy: { canEdit },
				localPeer: { id: "tester" },
			}),
			{ ctx },
		);
		await harness.runInit();

		const ir = deepIR();
		await harness.registration.hooks?.onDataChange?.(ctx, irToPuckData(ir));

		// The deep IR has nodes: root, branch, leaf, leaf (duplicate id).
		// puckDataToIR may re-derive ids — the assertion is that
		// canEdit is called once per UNIQUE id, not once per traversal
		// visit. Total unique ids in puck-derived IR == calls.
		const callsByNodeId = new Map<string, number>();
		for (const call of canEdit.mock.calls) {
			const node = call[0] as PageIRNode;
			callsByNodeId.set(node.id, (callsByNodeId.get(node.id) ?? 0) + 1);
		}
		for (const [, count] of callsByNodeId) {
			expect(count).toBe(1);
		}
	});

	it("does NOT cache across separate enforcement calls (policy state changes take effect)", async () => {
		let returnValue = true;
		const canEdit = vi.fn(() => returnValue);
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch: vi.fn() }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const onPolicyViolation = vi.fn();
		const harness = await registerPlugin(
			createCollabPlugin({
				adapter: fakeAdapter(),
				puckConfig: STUB_CONFIG,
				policy: { canEdit },
				localPeer: { id: "tester" },
				onPolicyViolation,
			}),
			{ ctx },
		);
		await harness.runInit();

		const ir = createFakePageIR();
		const data = irToPuckData(ir);

		// First save: allowed
		await harness.registration.hooks?.onDataChange?.(ctx, data);
		expect(onPolicyViolation).not.toHaveBeenCalled();

		// Policy state flips
		returnValue = false;

		// Second save with the SAME ir/peer: must NOT use a cached
		// "allowed" decision from the first call.
		await harness.registration.hooks?.onDataChange?.(ctx, data);
		expect(onPolicyViolation).toHaveBeenCalled();
	});
});
