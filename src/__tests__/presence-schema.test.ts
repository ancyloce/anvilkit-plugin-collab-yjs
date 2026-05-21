import { describe, expect, it } from "vitest";

import {
	MAX_DISPLAY_NAME_LENGTH,
	sanitizeDisplayName,
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

	// M4 hardening — color allowlist
	it("accepts #rgb / #rrggbb / #rrggbbaa hex colors", () => {
		expect(validatePeerInfo({ id: "a", color: "#f43" })).not.toBeNull();
		expect(validatePeerInfo({ id: "a", color: "#f43f5e" })).not.toBeNull();
		expect(validatePeerInfo({ id: "a", color: "#f43f5eaa" })).not.toBeNull();
	});

	it("accepts rgb() and rgba() colors", () => {
		expect(
			validatePeerInfo({ id: "a", color: "rgb(244, 63, 94)" }),
		).not.toBeNull();
		expect(
			validatePeerInfo({ id: "a", color: "rgba(244, 63, 94, 0.5)" }),
		).not.toBeNull();
	});

	it("accepts hsl() and hsla() colors", () => {
		expect(validatePeerInfo({ id: "a", color: "hsl(214, 70%, 55%)" })).toEqual({
			id: "a",
			color: "hsl(214, 70%, 55%)",
		});
		expect(
			validatePeerInfo({ id: "a", color: "hsla(214, 70%, 55%, 0.5)" }),
		).toEqual({ id: "a", color: "hsla(214, 70%, 55%, 0.5)" });
	});

	it("accepts an allowlisted named color", () => {
		expect(validatePeerInfo({ id: "a", color: "red" })).not.toBeNull();
		expect(validatePeerInfo({ id: "a", color: "TRANSPARENT" })).not.toBeNull();
	});

	it("REJECTS XSS-style color strings", () => {
		expect(
			validatePeerInfo({ id: "a", color: "javascript:alert(1)" }),
		).toBeNull();
		expect(
			validatePeerInfo({
				id: "a",
				color: "expression(alert(1))",
			}),
		).toBeNull();
		expect(
			validatePeerInfo({ id: "a", color: "</style><script>x</script>" }),
		).toBeNull();
		expect(validatePeerInfo({ id: "a", color: "unknownColorName" })).toBeNull();
	});

	it("REJECTS color strings exceeding the 32-char cap", () => {
		const long = `#${"a".repeat(50)}`;
		expect(validatePeerInfo({ id: "a", color: long })).toBeNull();
	});

	it("caps displayName to MAX_DISPLAY_NAME_LENGTH and strips control characters", () => {
		const longName = "x".repeat(MAX_DISPLAY_NAME_LENGTH + 20);
		const result = validatePeerInfo({
			id: "a",
			displayName: `${longName}\x00\x07\x1f`,
		});
		expect(result?.displayName).toBe("x".repeat(MAX_DISPLAY_NAME_LENGTH));
	});

	it("sanitizeDisplayName strips control chars and caps length", () => {
		expect(sanitizeDisplayName("hello\x00world")).toBe("helloworld");
		expect(sanitizeDisplayName("a".repeat(100)).length).toBe(
			MAX_DISPLAY_NAME_LENGTH,
		);
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
