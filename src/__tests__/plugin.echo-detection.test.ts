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
	let saved = createFakePageIR();
	let listener: ((ir: typeof saved, peer?: PeerInfo) => void) | undefined;
	const snapshots: SnapshotMeta[] = [];
	const savedIRs: ReturnType<typeof createFakePageIR>[] = [];
	return {
		savedIRs,
		save(ir: typeof saved) {
			saved = ir;
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
		load() {
			return saved;
		},
		subscribe(onUpdate: (ir: typeof saved, peer?: PeerInfo) => void) {
			listener = onUpdate;
			return () => {
				listener = undefined;
			};
		},
		pushUpdate(ir?: typeof saved, peer?: PeerInfo) {
			if (ir) saved = ir;
			listener?.(saved, peer);
		},
	} satisfies SnapshotAdapter & {
		pushUpdate: (ir?: typeof saved, peer?: PeerInfo) => void;
		readonly savedIRs: ReturnType<typeof createFakePageIR>[];
	};
}

describe("createCollabPlugin echo detection (H1)", () => {
	it("does not drop a local edit after two IDENTICAL remote dispatches with the same Puck data", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "local-test" },
			}),
			{ ctx },
		);
		await harness.runInit();

		const sharedIR = createFakePageIR({ rootId: "shared-root" });
		const sharedData = irToPuckData(sharedIR);

		// Two identical remote dispatches push the same key into the
		// pending-remote-data map. The count-based map records 2 echoes,
		// so the two subsequent local onDataChange calls cancel them.
		adapter.pushUpdate(sharedIR);
		adapter.pushUpdate(sharedIR);
		await harness.registration.hooks?.onDataChange?.(ctx, sharedData);
		await harness.registration.hooks?.onDataChange?.(ctx, sharedData);
		expect(adapter.savedIRs).toHaveLength(0);

		// A GENUINE local edit (different IR, different key) must NOT be
		// suppressed even though earlier identical-remote-dispatch state
		// existed. Under the old indexOf+splice scheme this third change
		// could still find a pending key and incorrectly drop it.
		const localChange = createFakePageIR({ rootId: "local-change" });
		await harness.registration.hooks?.onDataChange?.(
			ctx,
			irToPuckData(localChange),
		);
		expect(adapter.savedIRs).toHaveLength(1);
	});

	it("decrements echo count per consume so a refcount stays bounded under bursts", async () => {
		const adapter = fakeAdapter();
		const dispatch = vi.fn();
		const ctx = createFakeStudioContext({
			getPuckApi: vi.fn(
				() => ({ dispatch }) as unknown as PuckApi,
			) as unknown as StudioPluginContext["getPuckApi"],
		});
		const harness = await registerPlugin(
			createCollabPlugin({
				adapter,
				puckConfig: STUB_CONFIG,
				localPeer: { id: "local-test" },
			}),
			{ ctx },
		);
		await harness.runInit();

		// Push the same remote IR 5 times in a burst, then consume 5
		// matching onDataChange events. The 6th must hit the save path
		// because the refcount has reached zero — proving the map state
		// is bounded, not leaking one entry per remote dispatch.
		const remote = createFakePageIR({ rootId: "burst-remote" });
		const remoteData = irToPuckData(remote);
		for (let i = 0; i < 5; i += 1) adapter.pushUpdate(remote);
		for (let i = 0; i < 5; i += 1) {
			await harness.registration.hooks?.onDataChange?.(ctx, remoteData);
		}
		expect(adapter.savedIRs).toHaveLength(0);

		await harness.registration.hooks?.onDataChange?.(ctx, remoteData);
		expect(adapter.savedIRs).toHaveLength(1);
	});
});
