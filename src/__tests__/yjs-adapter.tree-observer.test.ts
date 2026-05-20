import type { PageIR } from "@anvilkit/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdateV2, Doc as YDoc, encodeStateAsUpdateV2 } from "yjs";

import { decodeIR } from "../encode.js";
import { createYjsAdapter } from "../yjs-adapter.js";

function ir(rootId: string, title: string): PageIR {
  return {
    version: "1",
    root: {
      id: rootId,
      type: "Root",
      props: {},
      children: [{ id: "c1", type: "Block", props: { title } }],
    },
    assets: [],
    metadata: {},
  } as PageIR;
}

function shuttle(from: YDoc, to: YDoc, origin: unknown): void {
  applyUpdateV2(to, encodeStateAsUpdateV2(from), origin);
}

describe("yjs-adapter tree observer (H3)", () => {
  it("emits remote updates via the native-tree observer with peer attribution and no double-emit", () => {
    const docA = new YDoc();
    const docB = new YDoc();
    const a = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
    const b = createYjsAdapter({ doc: docB, peer: { id: "bob" } });
    const received: { ir: PageIR; peer?: { id: string } }[] = [];
    a.subscribe((remote, peer) => received.push({ ir: remote, peer }));

    b.save(ir("r", "hello"), {});
    shuttle(docB, docA, { id: "bob" });

    // Exactly one emit (tree observer handled it; the legacy
    // map.observe fallback did not double-fire).
    expect(received).toHaveLength(1);
    expect(received[0]?.ir.root.children?.[0]?.props.title).toBe("hello");
    expect(received[0]?.peer?.id).toBe("bob");

    a.destroy();
    b.destroy();
  });

  it("does not emit for the adapter's own local saves", () => {
    const doc = new YDoc();
    const a = createYjsAdapter({ doc, peer: { id: "alice" } });
    const received: PageIR[] = [];
    a.subscribe((r) => received.push(r));
    a.save(ir("r", "local"), {});
    expect(received).toHaveLength(0);
    a.destroy();
  });
});

describe("yjs-adapter blob checkpoint (H3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("native mode throttles the PAGE_IR_KEY blob but refreshes after the checkpoint interval", () => {
    const doc = new YDoc();
    const map = doc.getMap<string>("anvilkit-collab");
    const a = createYjsAdapter({ doc, peer: { id: "alice" } });

    a.save(ir("r", "v1"), {}); // first save always writes the blob
    expect(
      decodeIR(map.get("pageIR") as string).root.children?.[0]?.props.title,
    ).toBe("v1");

    vi.advanceTimersByTime(1000);
    a.save(ir("r", "v2"), {}); // within 5s — blob NOT refreshed
    expect(
      decodeIR(map.get("pageIR") as string).root.children?.[0]?.props.title,
    ).toBe("v1");

    vi.advanceTimersByTime(6000);
    a.save(ir("r", "v3"), {}); // past checkpoint — blob refreshed
    expect(
      decodeIR(map.get("pageIR") as string).root.children?.[0]?.props.title,
    ).toBe("v3");
    a.destroy();
  });

  it("legacy mode writes the blob on every save", () => {
    const doc = new YDoc();
    const map = doc.getMap<string>("anvilkit-collab");
    const a = createYjsAdapter({
      doc,
      peer: { id: "alice" },
      useNativeTree: false,
    });
    a.save(ir("r", "v1"), {});
    a.save(ir("r", "v2"), {});
    expect(
      decodeIR(map.get("pageIR") as string).root.children?.[0]?.props.title,
    ).toBe("v2");
    a.destroy();
  });
});
