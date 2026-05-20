/**
 * Stage 1 / review §4 — the exact-data `pendingRemoteData` echo
 * fallback is now LAZY. The synchronous-host echo (Puck fires
 * `onChange` inside `api.dispatch`) is fully handled by the active
 * remote guard with zero `stableStringify`. The O(document)
 * exact-data fallback is registered ONLY when the dispatch produced
 * no synchronous echo — i.e. an async / pathological host.
 *
 * These two cases pin the contract precisely: the fallback exists
 * iff the host is async. (Removing the redundant 60s-lingering key
 * for synchronous hosts is the deliberate narrowing the review's P1
 * "keep exact-data matching only as a legacy fallback" asked for.)
 */

import {
  createFakePageIR,
  createFakeStudioContext,
  registerPlugin,
} from "@anvilkit/core/testing";
import type { PageIR, StudioPluginContext } from "@anvilkit/core/types";
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

function oneChild(headline: string): PageIR {
  const ir = createFakePageIR();
  return {
    ...ir,
    root: {
      ...ir.root,
      children: [{ id: "c1", type: "Hero", props: { headline } }],
    },
  };
}

function fakeAdapter() {
  let listener: ((ir: PageIR) => void) | undefined;
  const savedIRs: PageIR[] = [];
  const snapshots: SnapshotMeta[] = [];
  return {
    savedIRs,
    save(ir: PageIR) {
      savedIRs.push(ir);
      return `id-${snapshots.length}`;
    },
    list() {
      return snapshots;
    },
    load() {
      return createFakePageIR();
    },
    subscribe(on: (ir: PageIR) => void) {
      listener = on;
      return () => {
        listener = undefined;
      };
    },
    pushUpdate(ir: PageIR) {
      listener?.(ir);
    },
  } satisfies SnapshotAdapter & {
    pushUpdate: (ir: PageIR) => void;
    readonly savedIRs: PageIR[];
  };
}

describe("Stage 1 — lazy exact-data echo fallback", () => {
  it("async host: a late onChange of the exact remote data is still suppressed", async () => {
    const adapter = fakeAdapter();
    const remoteIR = oneChild("remote");
    // Async host: dispatch does NOT fire onChange synchronously.
    const dispatch = vi.fn();
    const ctx = createFakeStudioContext({
      getData: () => irToPuckData(oneChild("base")) as never,
      getPuckApi: vi.fn(
        () => ({ dispatch }) as unknown as PuckApi,
      ) as unknown as StudioPluginContext["getPuckApi"],
    });
    const harness = await registerPlugin(
      createCollabDataPlugin({
        adapter,
        puckConfig: STUB_CONFIG,
        localPeer: { id: "local" },
        inboundScheduler: syncInboundScheduler(),
      }),
      { ctx },
    );
    const onChange = harness.registration.hooks?.onDataChange as (
      c: unknown,
      d: unknown,
    ) => Promise<void>;
    await harness.runInit();

    adapter.pushUpdate(remoteIR);
    // Late async echo of the exact dispatched data → lazy fallback
    // registered in finally must suppress it.
    await onChange(ctx, irToPuckData(remoteIR));
    expect(adapter.savedIRs).toHaveLength(0);

    // A genuine different local edit still saves.
    await onChange(ctx, irToPuckData(oneChild("typed")));
    expect(adapter.savedIRs).toHaveLength(1);
  });

  it("sync host: guard handles the echo; no lingering exact-data fallback", async () => {
    const adapter = fakeAdapter();
    const remoteIR = oneChild("remote");
    let onChange: ((c: unknown, d: unknown) => Promise<void>) | undefined;
    // Sync host: Puck fires onChange synchronously inside dispatch.
    const dispatch = vi.fn((action: { type: string }) => {
      void onChange?.(ctx, irToPuckData(remoteIR));
      void action;
    });
    const ctx = createFakeStudioContext({
      getData: () => irToPuckData(oneChild("base")) as never,
      getPuckApi: vi.fn(
        () => ({ dispatch }) as unknown as PuckApi,
      ) as unknown as StudioPluginContext["getPuckApi"],
    });
    const harness = await registerPlugin(
      createCollabDataPlugin({
        adapter,
        puckConfig: STUB_CONFIG,
        localPeer: { id: "local" },
        inboundScheduler: syncInboundScheduler(),
      }),
      { ctx },
    );
    onChange = harness.registration.hooks?.onDataChange as (
      c: unknown,
      d: unknown,
    ) => Promise<void>;
    await harness.runInit();

    adapter.pushUpdate(remoteIR);
    // The synchronous echo(es) were suppressed by the active guard.
    expect(adapter.savedIRs).toHaveLength(0);

    // Stage-1 contract: because the guard already consumed the
    // synchronous echo, NO exact-data fallback was registered. A
    // later standalone onChange (even of the exact remote data) is
    // therefore a genuine local edit and IS saved — the redundant
    // 60s-lingering key that the old eager path kept is gone.
    await onChange(ctx, irToPuckData(remoteIR));
    expect(adapter.savedIRs).toHaveLength(1);
  });
});
