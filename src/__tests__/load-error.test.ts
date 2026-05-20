import { createFakePageIR } from "@anvilkit/core/testing";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

import {
  SnapshotCorruptedError,
  SnapshotNotFoundError,
  SnapshotPrunedError,
} from "../snapshot-errors.js";
import { createYjsAdapter } from "../yjs-adapter.js";

describe("createYjsAdapter load() error context (M7)", () => {
  it("wraps decode failures with snapshot id and underlying cause", () => {
    const doc = new YDoc();
    const adapter = createYjsAdapter({ doc });

    // Save a real snapshot so the index/meta exists, then corrupt
    // the payload directly in the underlying Y.Map.
    const id = adapter.save(createFakePageIR(), { label: "v1" });
    const map = doc.getMap<string>("anvilkit-collab");
    map.set(`snapshotPayload:${id}`, "{{not-valid-json");

    try {
      adapter.load(id);
      throw new Error("expected load() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      // R3 — typed: corruption is distinct from pruned / not-found.
      expect(error).toBeInstanceOf(SnapshotCorruptedError);
      const e = error as SnapshotCorruptedError;
      expect(e.name).toBe("SnapshotCorruptedError");
      expect(e.id).toBe(id);
      expect(e.message).toContain(id);
      expect(e.message).toContain("failed to decode snapshot");
      // Node's Error 'cause' is on the instance directly.
      expect((e as Error & { cause?: unknown }).cause).toBeDefined();
    }
  });

  it("still throws the original 'no snapshot' error when id is unknown", () => {
    const adapter = createYjsAdapter({ doc: new YDoc() });
    expect(() => adapter.load("nope")).toThrowError(/no snapshot with id/);
  });

  it("R3 — unknown id throws a typed SnapshotNotFoundError", () => {
    const adapter = createYjsAdapter({ doc: new YDoc() });
    try {
      adapter.load("nope");
      throw new Error("expected load() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotNotFoundError);
      expect(error).not.toBeInstanceOf(SnapshotPrunedError);
      expect((error as SnapshotNotFoundError).id).toBe("nope");
    }
  });

  it("R3 — a retention-pruned id throws a typed SnapshotPrunedError", () => {
    const adapter = createYjsAdapter({ doc: new YDoc(), maxSnapshots: 2 });
    const oldest = adapter.save(createFakePageIR(), { label: "v1" });
    adapter.save(createFakePageIR(), { label: "v2" });
    adapter.save(createFakePageIR(), { label: "v3" }); // evicts `oldest`

    expect(adapter.list().some((m) => m.id === oldest)).toBe(false);
    try {
      adapter.load(oldest);
      throw new Error("expected load() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotPrunedError);
      expect(error).not.toBeInstanceOf(SnapshotNotFoundError);
      const e = error as SnapshotPrunedError;
      expect(e.id).toBe(oldest);
      expect(e.message).toContain("pruned");
    }
  });
});
