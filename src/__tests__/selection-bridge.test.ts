/**
 * @file Phase 3 (D9) — selection-bridge selector tests.
 *
 * The hook itself (`usePuckSelection()`) is a thin wrapper over
 * `createUsePuck()` that delegates to `selectPresenceSelection`.
 * Mounting the real Puck editor is out of scope for the plugin's
 * node-only vitest setup, so we test the pure selector directly.
 * Hosts (and the Phase 3 demo wiring follow-up) cover the integrated
 * hook path.
 */

import type { ComponentData as PuckComponentData } from "@puckeditor/core";
import { describe, expect, it } from "vitest";

import { selectPresenceSelection } from "../selection-bridge.js";

function withSelectedItem(props: Readonly<Record<string, unknown>>): {
	readonly selectedItem: PuckComponentData;
} {
	return {
		selectedItem: {
			type: "Hero",
			props,
		} as unknown as PuckComponentData,
	};
}

describe("selectPresenceSelection", () => {
	it("returns null when nothing is selected", () => {
		expect(selectPresenceSelection({ selectedItem: null })).toBeNull();
	});

	it("returns { nodeIds: [id] } when a Puck item with props.id is selected", () => {
		expect(selectPresenceSelection(withSelectedItem({ id: "hero-1" }))).toEqual(
			{
				nodeIds: ["hero-1"],
			},
		);
	});

	it("returns null when the selected item has no props.id", () => {
		expect(selectPresenceSelection(withSelectedItem({}))).toBeNull();
	});

	it("returns null when props.id is not a string", () => {
		expect(selectPresenceSelection(withSelectedItem({ id: 42 }))).toBeNull();
	});

	it("ignores additional props and only projects the id", () => {
		expect(
			selectPresenceSelection(
				withSelectedItem({ id: "card-7", headline: "Hi", count: 3 }),
			),
		).toEqual({ nodeIds: ["card-7"] });
	});
});
