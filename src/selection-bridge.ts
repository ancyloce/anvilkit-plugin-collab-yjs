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
 * node id changes — Puck's selector hook compares results with
 * `Object.is`, so projecting `selectedItem.props.id` keeps the cost
 * identical to a Zustand selector subscription.
 */

import type { PresenceSelection } from "@anvilkit/plugin-version-history";
import {
	createUsePuck,
	type ComponentData as PuckComponentData,
} from "@puckeditor/core";

type PuckSelectorHook = <T>(
	selector: (state: { readonly selectedItem: PuckComponentData | null }) => T,
) => T;

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
	return usePuckSelection(selectPresenceSelection);
}

/**
 * Pure projection from Puck's selector state to `PresenceSelection`.
 * Exported so unit tests can exercise the selection rules without
 * mounting the editor.
 */
export function selectPresenceSelection(state: {
	readonly selectedItem: PuckComponentData | null;
}): PresenceSelection | null {
	const item = state.selectedItem;
	if (item === null) return null;
	const id = readId(item);
	if (id === undefined) return null;
	return { nodeIds: [id] };
}

function readId(item: PuckComponentData): string | undefined {
	const props = item.props as { readonly id?: unknown };
	return typeof props.id === "string" ? props.id : undefined;
}
