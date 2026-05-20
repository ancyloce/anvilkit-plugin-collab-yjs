/**
 * I2 (P1) — the shared Y.Doc must not grow unboundedly. Every `save()`
 * appended a full-document payload+meta with no pruning. The adapter
 * now enforces a hard `maxSnapshots` ceiling, evicting the oldest
 * payload+meta in the same transaction as the write. The newest
 * snapshot and the live state survive, so `forceResync` keeps working.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import { SnapshotPrunedError } from "../snapshot-errors.js";
import { createYjsAdapter } from "../yjs-adapter.js";

function irWith(label: string): PageIR {
  const base = createFakePageIR();
  return { ...base, metadata: { ...base.metadata, title: label } };
}

describe("snapshot retention cap (I2)", () => {
  it("bounds the retained snapshot set and evicts oldest first", () => {
    const adapter = createYjsAdapter({ doc: new YDoc(), maxSnapshots: 3 });
    const ids = Array.from({ length: 7 }, (_, i) =>
      adapter.save(irWith(`v${i}`), { label: `v${i}` }),
    );

    const list = adapter.list();
    expect(list).toHaveLength(3); // hard cap, not 7
    // Newest 3 retained, in order.
    expect(list.map((m) => m.label)).toEqual(["v4", "v5", "v6"]);

    // Oldest 4 evicted — payload gone. R3: load() now throws a
    // typed SnapshotPrunedError (distinct from not-found/corruption)
    // so a history UI can degrade to "pruned by retention".
    for (let i = 0; i < 4; i += 1) {
      expect(() => adapter.load(ids[i] as string)).toThrow(SnapshotPrunedError);
    }
    // Newest 3 still load their exact payloads.
    for (let i = 4; i < 7; i += 1) {
      expect(adapter.load(ids[i] as string).metadata.title).toBe(`v${i}`);
    }
  });

  it("a thousand keystroke saves stay bounded (no unbounded growth)", () => {
    const adapter = createYjsAdapter({ doc: new YDoc(), maxSnapshots: 50 });
    for (let i = 0; i < 1000; i += 1) adapter.save(irWith(`k${i}`), {});
    expect(adapter.list().length).toBeLessThanOrEqual(50);
  });

  it("forceResync still restores the latest state after eviction", async () => {
    const adapter = createYjsAdapter({ doc: new YDoc(), maxSnapshots: 2 });
    adapter.save(irWith("old"), { label: "old" });
    adapter.save(irWith("mid"), { label: "mid" });
    adapter.save(irWith("latest"), { label: "latest" });

    const restored = await adapter.forceResync();
    expect(restored?.metadata.title).toBe("latest");
    expect(adapter.list().map((m) => m.label)).toEqual(["mid", "latest"]);
  });

  it("default cap (no option) does not evict normal snapshot counts", () => {
    const adapter = createYjsAdapter({ doc: new YDoc() });
    const a = adapter.save(irWith("a"), { label: "a" });
    const b = adapter.save(irWith("b"), { label: "b" });
    expect(adapter.list().map((m) => m.id)).toEqual([a, b]);
    expect(adapter.load(a).metadata.title).toBe("a");
  });

  it("maxSnapshots <= 0 disables the cap", () => {
    const adapter = createYjsAdapter({ doc: new YDoc(), maxSnapshots: 0 });
    for (let i = 0; i < 20; i += 1) adapter.save(irWith(`u${i}`), {});
    expect(adapter.list().length).toBe(20);
  });
});
