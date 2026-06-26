// @vitest-environment jsdom
/**
 * @file Report 0006 §4.2.5 — multi-select sibling of `usePuckSelection`.
 *
 * `usePuckMultiSelection(extraNodeIds)` merges the single Puck
 * `selectedItem` (primary) with host-tracked additional ids, sanitizes
 * the result, and returns a multi-id `PresenceSelection` — without
 * touching the existing single-id `usePuckSelection` contract.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let selectorState: { selectedItem: { props: { id: string } } | null } = {
	selectedItem: null,
};

vi.mock("@puckeditor/core", () => ({
	createUsePuck:
		() =>
		<T>(selector: (s: typeof selectorState) => T): T =>
			selector(selectorState),
}));

import { usePuckMultiSelection } from "../utils/selection-bridge.js";

afterEach(() => {
	selectorState = { selectedItem: null };
});

describe("usePuckMultiSelection (§4.2.5)", () => {
	it("returns null when nothing is selected and no extra ids", () => {
		const { result } = renderHook(() => usePuckMultiSelection());
		expect(result.current).toBeNull();
	});

	it("returns the single primary selection when no extra ids", () => {
		selectorState = { selectedItem: { props: { id: "primary" } } };
		const { result } = renderHook(() => usePuckMultiSelection());
		expect(result.current).toEqual({ nodeIds: ["primary"] });
	});

	it("merges the primary selection with host-tracked extra ids (primary first, de-duplicated)", () => {
		selectorState = { selectedItem: { props: { id: "primary" } } };
		const { result } = renderHook(() =>
			usePuckMultiSelection(["extra-1", "primary", "extra-2"]),
		);
		expect(result.current).toEqual({
			nodeIds: ["primary", "extra-1", "extra-2"],
		});
	});

	it("returns a multi-id selection from extra ids alone when nothing is selected in Puck", () => {
		const { result } = renderHook(() => usePuckMultiSelection(["a", "b", "c"]));
		expect(result.current).toEqual({ nodeIds: ["a", "b", "c"] });
	});

	it("drops invalid extra ids and keeps the valid ones", () => {
		const { result } = renderHook(() =>
			usePuckMultiSelection(["good", "", "  ".repeat(0)]),
		);
		expect(result.current).toEqual({ nodeIds: ["good"] });
	});
});
