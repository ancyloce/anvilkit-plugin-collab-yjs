// @vitest-environment jsdom
/**
 * B1 — `usePuckSelection()` must return a referentially STABLE
 * `{ nodeIds: [id] }` across re-evaluations while the selected id is
 * unchanged (so consumer effects keyed on it don't re-run on
 * unrelated Puck state churn), and a NEW reference when the selected
 * id actually changes.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Drive the hook from a mutable selector state. `createUsePuck()`
// returns a selector hook; our mock applies the selector to the
// current state so each (re-)render re-projects exactly like Puck.
let selectorState: { selectedItem: { props: { id: string } } | null } = {
	selectedItem: null,
};

vi.mock("@puckeditor/core", () => ({
	createUsePuck:
		() =>
		<T>(selector: (s: typeof selectorState) => T): T =>
			selector(selectorState),
}));

import { usePuckSelection } from "../selection-bridge.js";

afterEach(() => {
	selectorState = { selectedItem: null };
});

describe("usePuckSelection — referential stability (B1)", () => {
	it("keeps the same object reference while the selected id is unchanged", () => {
		selectorState = { selectedItem: { props: { id: "node-a" } } };
		const { result, rerender } = renderHook(() => usePuckSelection());

		const first = result.current;
		expect(first).toEqual({ nodeIds: ["node-a"] });

		// Unrelated Puck churn: a brand-new selectedItem object, SAME id.
		selectorState = { selectedItem: { props: { id: "node-a" } } };
		rerender();
		expect(result.current).toBe(first); // identical reference

		rerender();
		expect(result.current).toBe(first);
	});

	it("returns a new reference when the selected id changes", () => {
		selectorState = { selectedItem: { props: { id: "node-a" } } };
		const { result, rerender } = renderHook(() => usePuckSelection());
		const first = result.current;

		selectorState = { selectedItem: { props: { id: "node-b" } } };
		rerender();
		expect(result.current).not.toBe(first);
		expect(result.current).toEqual({ nodeIds: ["node-b"] });

		selectorState = { selectedItem: null };
		rerender();
		expect(result.current).toBeNull();
	});
});
