/**
 * Stage 2 correctness lock — every projection `projectChangedNodes`
 * ACCEPTS must be byte-identical to the proven `irToPuckData(newIR)`
 * round-trip, and every shape it cannot prove it reproduces must
 * return `null` so `dispatchRemoteIR` falls back to full conversion.
 */

import type { PageIR } from "@anvilkit/core/types";
import { irToPuckData } from "@anvilkit/ir";
import { describe, expect, it } from "vitest";

import {
  type ProjectionData,
  projectChangedNodes,
} from "../incremental-projection.js";

function ir(children: PageIR["root"]["children"]): PageIR {
  return {
    version: 1,
    root: { id: "root", type: "Root", props: {}, children },
  } as unknown as PageIR;
}

const asData = (r: PageIR): ProjectionData =>
  irToPuckData(r) as unknown as ProjectionData;

describe("projectChangedNodes — correctness vs full round-trip", () => {
  it("flat content: a single changed prop equals irToPuckData(newIR)", () => {
    const before = asData(
      ir([
        { id: "a", type: "Hero", props: { t: "a0" } },
        { id: "b", type: "Hero", props: { t: "b0" } },
        { id: "c", type: "Hero", props: { t: "c0" } },
      ]),
    );
    const newIR = ir([
      { id: "a", type: "Hero", props: { t: "a0" } },
      { id: "b", type: "Hero", props: { t: "b1" } },
      { id: "c", type: "Hero", props: { t: "c0" } },
    ]);
    const out = projectChangedNodes(before, newIR, new Set(["b"]));
    expect(out).not.toBeNull();
    expect(out).toEqual(irToPuckData(newIR));
    // Untouched items keep object identity (planner free-skip).
    expect(out?.content?.[0]).toBe(before.content?.[0]);
    expect(out?.content?.[2]).toBe(before.content?.[2]);
  });

  it("multiple changed ids in one flush equal the full round-trip", () => {
    const before = asData(
      ir([
        { id: "a", type: "Hero", props: { t: "a0" } },
        { id: "b", type: "Hero", props: { t: "b0" } },
      ]),
    );
    const newIR = ir([
      { id: "a", type: "Hero", props: { t: "a9" } },
      { id: "b", type: "Hero", props: { t: "b9" } },
    ]);
    const out = projectChangedNodes(before, newIR, new Set(["a", "b"]));
    expect(out).toEqual(irToPuckData(newIR));
  });

  it("nested non-zone slot child: owner recompute equals the round-trip", () => {
    const mk = (inner: string): PageIR =>
      ir([
        {
          id: "card",
          type: "Card",
          props: { title: "T" },
          children: [
            {
              id: "btn",
              type: "Button",
              slot: "footer",
              props: { label: inner },
            },
          ],
        },
      ]);
    const before = asData(mk("v0"));
    const newIR = mk("v1");
    // Only the nested button's prop changed; its owner is "card".
    const out = projectChangedNodes(before, newIR, new Set(["btn"]));
    expect(out).not.toBeNull();
    expect(out).toEqual(irToPuckData(newIR));
  });

  it("returns null (→ full fallback) when an owner subtree has zone children", () => {
    const mk = (t: string): PageIR =>
      ir([
        {
          id: "cols",
          type: "Columns",
          props: { t },
          children: [
            {
              id: "z1",
              type: "Hero",
              slot: "left",
              slotKind: "zone",
              props: { t: "z" },
            },
          ],
        },
      ]);
    const before = asData(mk("v0"));
    expect(projectChangedNodes(before, mk("v1"), new Set(["cols"]))).toBeNull();
  });

  it("returns null for an unknown changed id and for a root-id change", () => {
    const before = asData(ir([{ id: "a", type: "Hero", props: { t: "0" } }]));
    const same = ir([{ id: "a", type: "Hero", props: { t: "0" } }]);
    expect(
      projectChangedNodes(before, same, new Set(["does-not-exist"])),
    ).toBeNull();
    expect(projectChangedNodes(before, same, new Set(["root"]))).toBeNull();
  });

  it("empty changed set is an identity (returns the same object)", () => {
    const before = asData(ir([{ id: "a", type: "Hero", props: {} }]));
    expect(projectChangedNodes(before, ir([]), new Set())).toBe(before);
  });
});
