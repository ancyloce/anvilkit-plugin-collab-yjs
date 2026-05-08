import { describe, expect, it } from "vitest";

import {
	validatePeerInfo,
	validatePresenceCursor,
	validatePresenceSelection,
	validatePresenceState,
} from "../presence-schema.js";

describe("validatePeerInfo", () => {
	it("accepts the minimum {id} shape", () => {
		expect(validatePeerInfo({ id: "alice" })).toEqual({ id: "alice" });
	});

	it("accepts displayName and color when both are strings", () => {
		const peer = { id: "alice", displayName: "Alice", color: "#f43f5e" };
		expect(validatePeerInfo(peer)).toEqual(peer);
	});

	it("rejects missing id", () => {
		expect(validatePeerInfo({})).toBeNull();
	});

	it("rejects empty id", () => {
		expect(validatePeerInfo({ id: "" })).toBeNull();
	});

	it("rejects non-string displayName", () => {
		expect(validatePeerInfo({ id: "alice", displayName: 42 })).toBeNull();
	});

	it("rejects non-object input", () => {
		expect(validatePeerInfo(null)).toBeNull();
		expect(validatePeerInfo("alice")).toBeNull();
		expect(validatePeerInfo([])).toBeNull();
	});
});

describe("validatePresenceCursor", () => {
	it("accepts finite numbers", () => {
		expect(validatePresenceCursor({ x: 12, y: 34 })).toEqual({ x: 12, y: 34 });
	});

	it("rejects NaN and Infinity", () => {
		expect(validatePresenceCursor({ x: Number.NaN, y: 0 })).toBeNull();
		expect(
			validatePresenceCursor({ x: 0, y: Number.POSITIVE_INFINITY }),
		).toBeNull();
	});

	it("rejects non-numeric inputs", () => {
		expect(validatePresenceCursor({ x: "12", y: 34 })).toBeNull();
	});
});

describe("validatePresenceSelection", () => {
	it("accepts a string array", () => {
		expect(validatePresenceSelection({ nodeIds: ["a", "b"] })).toEqual({
			nodeIds: ["a", "b"],
		});
	});

	it("accepts an empty array", () => {
		expect(validatePresenceSelection({ nodeIds: [] })).toEqual({ nodeIds: [] });
	});

	it("rejects non-string entries", () => {
		expect(validatePresenceSelection({ nodeIds: ["a", 1] })).toBeNull();
	});

	it("rejects missing nodeIds", () => {
		expect(validatePresenceSelection({})).toBeNull();
	});
});

describe("validatePresenceState", () => {
	it("accepts a peer-only state", () => {
		const state = { peer: { id: "alice" } };
		expect(validatePresenceState(state)).toEqual(state);
	});

	it("accepts a state with cursor and selection", () => {
		const state = {
			peer: { id: "alice", color: "#f43f5e" },
			cursor: { x: 1, y: 2 },
			selection: { nodeIds: ["root"] },
		};
		expect(validatePresenceState(state)).toEqual(state);
	});

	it("rejects malformed nested cursor", () => {
		const state = {
			peer: { id: "alice" },
			cursor: { x: "1", y: 2 },
		};
		expect(validatePresenceState(state)).toBeNull();
	});

	it("rejects malformed nested selection", () => {
		const state = {
			peer: { id: "alice" },
			selection: { nodeIds: "root" },
		};
		expect(validatePresenceState(state)).toBeNull();
	});

	it("rejects when peer is missing", () => {
		expect(validatePresenceState({ cursor: { x: 0, y: 0 } })).toBeNull();
	});
});
