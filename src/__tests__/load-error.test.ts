import { createFakePageIR } from "@anvilkit/core/testing";
import { describe, expect, it } from "vitest";
import { Doc as YDoc } from "yjs";

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
			const e = error as Error;
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
});
