/**
 * @file Report 0006 §4.2.5 — richer, versioned presence states.
 *
 * Exercises the versioned presence schema extension (multi-select,
 * viewport, focused-block, typing/activity) plus its sanitization
 * rules, and proves the richer fields survive the awareness
 * publish/subscribe round-trip while legacy single-selection peers
 * still validate.
 *
 * Written TDD-first: before the schema extension, `validatePresenceState`
 * rejected a selection containing any non-string id (strict path) and
 * never bounded an oversized id array, so the sanitization assertions
 * below fail; after the extension they pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import { Doc as YDoc } from "yjs";

import {
	MAX_NODE_ID_LENGTH,
	MAX_SELECTION_IDS,
	MAX_VIEWPORT_ZOOM,
	MIN_VIEWPORT_ZOOM,
	PRESENCE_SCHEMA_VERSION,
	sanitizePresenceSelection,
	validatePresenceActivity,
	validatePresenceState,
	validatePresenceViewport,
} from "../utils/presence-schema.js";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

describe("rich presence schema (§4.2.5)", () => {
	it("round-trips a richer presence state (multi-select + viewport + focused block + typing)", () => {
		const state = {
			version: PRESENCE_SCHEMA_VERSION,
			peer: { id: "alice", color: "#f43f5e" },
			cursor: { x: 10, y: 20 },
			selection: { nodeIds: ["a", "b", "c"] },
			viewport: { x: 100, y: 200, zoom: 1.5, width: 800, height: 600 },
			focusedId: "block-7",
			activity: { typing: true, updatedAt: 1_700_000_000_000 },
		};
		expect(validatePresenceState(state)).toEqual(state);
	});

	it("still validates a legacy single-selection presence with no version field", () => {
		const legacy = {
			peer: { id: "bob", color: "#22c55e" },
			cursor: { x: 1, y: 2 },
			selection: { nodeIds: ["only-one"] },
		};
		expect(validatePresenceState(legacy)).toEqual(legacy);
	});

	it("drops non-string / empty ids from a multi-select instead of rejecting the whole state", () => {
		const result = validatePresenceState({
			peer: { id: "a" },
			selection: {
				nodeIds: ["good-1", 42, "", "good-2", null, "  ".repeat(0)],
			},
		});
		// Strict legacy path returned null for a non-string entry; the rich
		// path keeps the valid ids and drops the rest.
		expect(result).not.toBeNull();
		expect(result?.selection?.nodeIds).toEqual(["good-1", "good-2"]);
	});

	it("bounds an oversized multi-select array to MAX_SELECTION_IDS", () => {
		const nodeIds = Array.from({ length: 10_000 }, (_, i) => `n${i}`);
		const result = validatePresenceState({
			peer: { id: "a" },
			selection: { nodeIds },
		});
		expect(result).not.toBeNull();
		expect(result?.selection?.nodeIds.length).toBe(MAX_SELECTION_IDS);
		expect(result?.selection?.nodeIds.length).toBeLessThan(10_000);
	});

	it("drops an over-long node id from a multi-select", () => {
		const tooLong = "x".repeat(MAX_NODE_ID_LENGTH + 1);
		const result = validatePresenceState({
			peer: { id: "a" },
			selection: { nodeIds: ["keep", tooLong] },
		});
		expect(result?.selection?.nodeIds).toEqual(["keep"]);
	});

	it("sanitizePresenceSelection rejects a non-array nodeIds but never throws on bad entries", () => {
		expect(sanitizePresenceSelection({ nodeIds: "root" })).toBeNull();
		expect(sanitizePresenceSelection({})).toBeNull();
		expect(sanitizePresenceSelection({ nodeIds: [1, 2, 3] })).toEqual({
			nodeIds: [],
		});
	});

	it("validates and clamps a viewport (out-of-range zoom, negative size)", () => {
		const result = validatePresenceViewport({
			x: 5,
			y: 6,
			zoom: 1_000_000,
			width: -10,
			height: 480,
		});
		expect(result).not.toBeNull();
		expect(result?.zoom).toBe(MAX_VIEWPORT_ZOOM);
		expect(result?.width).toBe(0);
		expect(result?.height).toBe(480);

		expect(validatePresenceViewport({ x: 0, y: 0, zoom: 0 })?.zoom).toBe(
			MIN_VIEWPORT_ZOOM,
		);
		expect(
			validatePresenceViewport({ x: Number.NaN, y: 0, zoom: 1 }),
		).toBeNull();
		expect(
			validatePresenceViewport({ x: 0, y: 0, zoom: Number.POSITIVE_INFINITY }),
		).toBeNull();
		expect(validatePresenceViewport("nope")).toBeNull();
	});

	it("validates activity/typing metadata and rejects malformed values", () => {
		expect(validatePresenceActivity({ typing: true, updatedAt: 123 })).toEqual({
			typing: true,
			updatedAt: 123,
		});
		expect(validatePresenceActivity({ typing: false })).toEqual({
			typing: false,
		});
		expect(validatePresenceActivity({})).toEqual({});
		expect(validatePresenceActivity({ typing: "yes" })).toBeNull();
		expect(
			validatePresenceActivity({ updatedAt: Number.POSITIVE_INFINITY }),
		).toBeNull();
		expect(validatePresenceActivity({ updatedAt: -5 })).toEqual({
			updatedAt: 0,
		});
	});

	it("rejects the whole state when a richer field is malformed (defense-in-depth)", () => {
		expect(
			validatePresenceState({
				peer: { id: "a" },
				viewport: { x: 0, y: 0, zoom: "big" },
			}),
		).toBeNull();
		expect(
			validatePresenceState({ peer: { id: "a" }, focusedId: 7 }),
		).toBeNull();
		expect(
			validatePresenceState({ peer: { id: "a" }, activity: { typing: 1 } }),
		).toBeNull();
	});
});

describe("rich presence over the awareness bridge (§4.2.5)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("surfaces the richer fields through presence.update + onPeerChange", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const adapter = createYjsAdapter({ doc, awareness, peer: { id: "alice" } });
		const callback = vi.fn();
		adapter.presence?.onPeerChange(callback);

		const rich = {
			version: PRESENCE_SCHEMA_VERSION,
			peer: { id: "alice", color: "#f43f5e" },
			selection: { nodeIds: ["a", "b"] },
			viewport: { x: 0, y: 0, zoom: 2 },
			focusedId: "blk-1",
			activity: { typing: true },
		};
		adapter.presence?.update(rich);
		vi.advanceTimersByTime(16);

		const last = callback.mock.calls.at(-1)?.[0] as readonly unknown[];
		expect(last).toContainEqual(rich);
	});

	it("sanitizes an oversized inbound selection from a peer's awareness state", () => {
		const doc = new YDoc();
		const awareness = new Awareness(doc);
		const adapter = createYjsAdapter({ doc, awareness, peer: { id: "me" } });
		const callback = vi.fn();
		adapter.presence?.onPeerChange(callback);

		const nodeIds = Array.from({ length: 1_000 }, (_, i) => `n${i}`);
		awareness.setLocalState({ peer: { id: "me" }, selection: { nodeIds } });
		vi.advanceTimersByTime(16);

		const last = callback.mock.calls.at(-1)?.[0] as ReadonlyArray<{
			readonly selection?: { readonly nodeIds: readonly string[] };
		}>;
		const peerState = last.find((s) => s.selection !== undefined);
		expect(peerState?.selection?.nodeIds.length).toBe(MAX_SELECTION_IDS);
	});
});
