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

import { createCollabDataPlugin } from "../plugin.js";
import { syncInboundScheduler } from "./helpers/inbound.js";

const STUB_CONFIG = { components: {} } as unknown as Config;

function fakeAdapter() {
  let listener: ((ir: ReturnType<typeof createFakePageIR>) => void) | undefined;
  const savedIRs: ReturnType<typeof createFakePageIR>[] = [];
  const snapshots: SnapshotMeta[] = [];
  return {
    savedIRs,
    save(ir: ReturnType<typeof createFakePageIR>) {
      savedIRs.push(ir);
      return `id-${snapshots.length}`;
    },
    list() {
      return snapshots;
    },
    load() {
      return createFakePageIR();
    },
    subscribe(on: (ir: ReturnType<typeof createFakePageIR>) => void) {
      listener = on;
      return () => {
        listener = undefined;
      };
    },
    pushUpdate(ir: ReturnType<typeof createFakePageIR>) {
      listener?.(ir);
    },
  } satisfies SnapshotAdapter & {
    pushUpdate: (ir: ReturnType<typeof createFakePageIR>) => void;
    readonly savedIRs: ReturnType<typeof createFakePageIR>[];
  };
}

const twoChildren = (a: string, b: string) =>
  createFakePageIR({
    rootId: "root",
    children: [
      { id: "c1", type: "Hero", props: { headline: a } },
      { id: "c2", type: "Hero", props: { headline: b } },
    ],
  });

describe("plugin multi-replace echo suppression (H2)", () => {
  it("suppresses every per-replace onDataChange during a multi-action remote dispatch", async () => {
    const adapter = fakeAdapter();
    const baseIR = twoChildren("old-1", "old-2");
    const remoteIR = twoChildren("new-1", "new-2"); // two props differ

    let onChange:
      | ((ctx: unknown, data: unknown) => unknown | Promise<unknown>)
      | undefined;
    const dispatch = vi.fn((action: { type: string }) => {
      // Puck fires onDataChange synchronously per replace, mid-loop.
      if (action.type === "replace") {
        void onChange?.(ctx, irToPuckData(remoteIR));
      }
    });
    const ctx = createFakeStudioContext({
      getData: () => irToPuckData(baseIR) as never,
      getPuckApi: vi.fn(
        () => ({ dispatch }) as unknown as PuckApi,
      ) as unknown as StudioPluginContext["getPuckApi"],
    });

    const harness = await registerPlugin(
      createCollabDataPlugin({
        adapter,
        puckConfig: STUB_CONFIG,
        localPeer: { id: "local-test" },
        inboundScheduler: syncInboundScheduler(),
      }),
      { ctx },
    );
    onChange = harness.registration.hooks?.onDataChange as typeof onChange;
    await harness.runInit();

    adapter.pushUpdate(remoteIR);

    // Two sibling props changed → ≥2 replace actions, each firing a
    // mid-loop onDataChange that must NOT reach adapter.save.
    const replaceCalls = dispatch.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "replace",
    );
    expect(replaceCalls.length).toBeGreaterThanOrEqual(2);
    expect(adapter.savedIRs).toHaveLength(0);

    // A genuine local edit AFTER the dispatch closes still saves.
    await onChange?.(ctx, irToPuckData(twoChildren("local-1", "local-2")));
    expect(adapter.savedIRs).toHaveLength(1);
  });
});
