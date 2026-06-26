/**
 * Phase 3 (D9) — selection bridge utility.
 *
 * `usePuckSelection()` subscribes to the Puck editor's reactive
 * selection store (via `createUsePuck()`) and returns a
 * `PresenceSelection` shape suitable for `presence.update`. Hosts
 * compose this with their `PeerInfo` to broadcast a peer's current
 * selection ring without hand-wiring Puck's selection events.
 *
 * The hook re-renders the calling component only when the selected
 * node id changes. It selects the PRIMITIVE id string first — Puck's
 * selector hook compares results with `Object.is`, and a string is
 * stable across renders — then memoizes the `{ nodeIds: [id] }`
 * wrapper with `useMemo` keyed by that id. The previous implementation
 * returned a fresh object (and fresh array) on every selector
 * evaluation, so `Object.is` always saw a new reference and every
 * consumer effect re-ran on unrelated Puck state changes (M2).
 */

import type { PresenceSelection } from "@anvilkit/plugin-version-history";
import {
	createUsePuck,
	type ComponentData as PuckComponentData,
} from "@puckeditor/core";
import { useMemo } from "react";
import { MAX_NODE_ID_LENGTH, MAX_SELECTION_IDS } from "./presence-schema.js";

type PuckSelectorState = { readonly selectedItem: PuckComponentData | null };

type PuckSelectorHook = <T>(selector: (state: PuckSelectorState) => T) => T;

// Lazy-initialized so test mocks of `@puckeditor/core` (which may not
// stub `createUsePuck`) don't blow up at module-evaluate time.
let _usePuckSelection: PuckSelectorHook | null = null;
function getUsePuckSelection(): PuckSelectorHook {
	if (_usePuckSelection === null) {
		_usePuckSelection = createUsePuck() as unknown as PuckSelectorHook;
	}
	return _usePuckSelection;
}

/**
 * Subscribe to the currently-selected canvas node id and return a
 * `PresenceSelection` suitable for `presence.update`. Returns `null`
 * when nothing is selected so hosts can short-circuit instead of
 * broadcasting an empty selection.
 *
 * The shape is intentionally narrow — only the selected node ids,
 * matching `PresenceSelection`'s `nodeIds` field. Multi-select
 * support remains out of scope for Phase 3; the hook returns a
 * single-element array when an item is selected.
 *
 * @example
 * ```tsx
 * function Cursor({ adapter }: { adapter: YjsSnapshotAdapter }) {
 *   const selection = usePuckSelection();
 *   useEffect(() => {
 *     adapter.presence?.update({
 *       peer: { id: "alice", color: "#f43f5e" },
 *       selection: selection ?? undefined,
 *     });
 *   }, [adapter, selection]);
 *   return null;
 * }
 * ```
 */
export function usePuckSelection(): PresenceSelection | null {
	const usePuckSelection = getUsePuckSelection();
	// Select the primitive id: `Object.is` over a string is stable, so
	// the underlying store subscription only re-renders this hook when
	// the SELECTED NODE actually changes — not on every unrelated Puck
	// state mutation.
	const id = usePuckSelection(selectSelectedId);
	return useMemo(() => (id === null ? null : { nodeIds: [id] }), [id]);
}

/**
 * Multi-select sibling of {@link usePuckSelection} (Report 0006 §4.2.5).
 *
 * Merges the single Puck `selectedItem` (the PRIMARY selection, placed
 * first) with `extraNodeIds` the host tracks itself — Puck's editor
 * store only models one selected node, so a host that wants to broadcast
 * a multi-node marquee/shift-click selection supplies the additional ids
 * here. The merged list is sanitized exactly like an inbound presence
 * selection: non-string / empty / over-long ids are dropped, duplicates
 * are removed (primary wins its position), and the result is truncated to
 * {@link MAX_SELECTION_IDS}. Returns `null` when the merged selection is
 * empty so hosts can short-circuit instead of broadcasting `{ nodeIds: [] }`.
 *
 * The single-id {@link usePuckSelection} contract is untouched.
 *
 * @example
 * ```tsx
 * const selection = usePuckMultiSelection(marqueeIds);
 * adapter.presence?.update({ peer, selection: selection ?? undefined });
 * ```
 */
export function usePuckMultiSelection(
	extraNodeIds?: readonly string[],
): PresenceSelection | null {
	const usePuckSelection = getUsePuckSelection();
	const id = usePuckSelection(selectSelectedId);
	return useMemo(() => {
		const nodeIds: string[] = [];
		const seen = new Set<string>();
		const add = (candidate: unknown): void => {
			if (nodeIds.length >= MAX_SELECTION_IDS) return;
			if (
				typeof candidate !== "string" ||
				candidate.length === 0 ||
				candidate.length > MAX_NODE_ID_LENGTH ||
				seen.has(candidate)
			) {
				return;
			}
			seen.add(candidate);
			nodeIds.push(candidate);
		};
		if (id !== null) add(id);
		if (extraNodeIds !== undefined) {
			for (const candidate of extraNodeIds) add(candidate);
		}
		return nodeIds.length === 0 ? null : { nodeIds };
	}, [id, extraNodeIds]);
}

/**
 * Pure projection to the primitive selected node id (or `null`).
 * Exported for unit tests; this is the value the store subscription
 * compares with `Object.is`.
 */
export function selectSelectedId(state: PuckSelectorState): string | null {
	const item = state.selectedItem;
	if (item === null) return null;
	return readId(item) ?? null;
}

/**
 * Pure projection from Puck's selector state to `PresenceSelection`.
 * Exported so unit tests can exercise the selection rules without
 * mounting the editor. Note: callers in render should prefer
 * {@link usePuckSelection} — this allocates a fresh object per call
 * and is not reference-stable by design.
 */
export function selectPresenceSelection(
	state: PuckSelectorState,
): PresenceSelection | null {
	const id = selectSelectedId(state);
	return id === null ? null : { nodeIds: [id] };
}

function readId(item: PuckComponentData): string | undefined {
	const props = item.props as { readonly id?: unknown };
	return typeof props.id === "string" ? props.id : undefined;
}
