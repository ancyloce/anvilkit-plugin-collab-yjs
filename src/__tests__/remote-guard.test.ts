import { describe, expect, it } from "vitest";

import { nowMs } from "../metrics.js";
import { createRemoteDispatchGuard } from "../remote-guard.js";

describe("createRemoteDispatchGuard (H2)", () => {
  it("is inactive until begin and active across re-entrant begins", () => {
    const g = createRemoteDispatchGuard();
    expect(g.isActive()).toBe(false);
    const t1 = g.begin();
    expect(g.isActive()).toBe(true);
    const t2 = g.begin();
    g.end(t1);
    // Still active — outer dispatch not finished.
    expect(g.isActive()).toBe(true);
    g.end(t2);
    expect(g.isActive()).toBe(false);
  });

  it("issues monotonic tokens and ignores a stale/duplicate end", () => {
    const g = createRemoteDispatchGuard();
    const a = g.begin();
    const b = g.begin();
    expect(b).toBeGreaterThan(a);
    g.end(a);
    g.end(a); // duplicate — must not underflow depth
    expect(g.isActive()).toBe(true);
    g.end(b);
    expect(g.isActive()).toBe(false);
    g.end(b); // stale — must not flip back to active
    expect(g.isActive()).toBe(false);
  });

  it("default grace is 0 — a local edit the instant after dispatch is NOT suppressed", () => {
    const g = createRemoteDispatchGuard();
    const t = g.begin();
    // R5 — callers pass the monotonic nowMs() (same clock the guard
    // times closedAt with), not Date.now().
    expect(g.withinGraceWindow(nowMs())).toBe(true);
    g.end(t);
    // Same tick, dispatch closed: not suppressed.
    expect(g.withinGraceWindow(nowMs())).toBe(false);
  });

  it("honors a positive grace window when configured", () => {
    const g = createRemoteDispatchGuard({ graceMs: 1000 });
    const t = g.begin();
    g.end(t);
    const now = nowMs();
    expect(g.withinGraceWindow(now)).toBe(true);
    expect(g.withinGraceWindow(now + 2000)).toBe(false);
  });
});
