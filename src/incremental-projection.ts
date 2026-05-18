/**
 * Stage 2 / review §3.2–3.3 — incremental IR→Puck projection.
 *
 * `dispatchRemoteIR` converted the ENTIRE merged IR to Puck data on
 * every inbound flush via `irToPuckData(full)`, even when the adapter
 * told us exactly one node's props changed. For a 2000-node CMS page
 * that allocates the whole Puck tree (content + zones + every nested
 * slot array) per keystroke-rate remote edit.
 *
 * This module produces the post-edit Puck data by **cloning the data
 * Puck already holds and recomputing only the top-level item(s) that
 * own a changed node** — O(changed), not O(document). Untouched items
 * keep their original object identity, so the downstream replace
 * planner's `a === b` short-circuit makes them free.
 *
 * Correctness over cleverness: this is a strictly additive fast path.
 * It returns `null` (→ caller falls back to the proven
 * `irToPuckData(full)` round-trip) for ANY shape it cannot prove it
 * reproduces byte-for-byte: a changed id with no current location, an
 * owner whose subtree contains zone-kind children (shared-zones side
 * effect), root-prop ownership, or a root-id change. The
 * `incremental-projection.test.ts` suite asserts every accepted
 * projection deep-equals `irToPuckData(newIR)`.
 */

import type { PageIR, PageIRNode } from "@anvilkit/core/types";

// Structural Puck-data shape — intentionally identical to the
// `PuckData` / `PuckContentItem` aliases in plugin.ts so the projected
// result drops straight into `planReplaceActions` without a cast and
// without coupling this module to `@puckeditor/core`.
export type PuckContentItem = {
	readonly type: string;
	readonly props: Readonly<Record<string, unknown>> & { readonly id: string };
};
export type ProjectionData = {
	readonly content?: ReadonlyArray<PuckContentItem>;
	readonly zones?: Readonly<Record<string, ReadonlyArray<PuckContentItem>>>;
	readonly root?: unknown;
};

type PageIRNodeWithSlots = PageIRNode & {
	readonly slot?: string;
	readonly slotKind?: "slot" | "zone";
	readonly children?: readonly PageIRNodeWithSlots[];
};

const DEFAULT_NESTED_SLOT = "children";

/** ROOT content sentinel — kept identical to plugin.ts's value. */
export const ROOT_DROPPABLE_ID = "root:default-zone";

type OwnerLocation =
	| { readonly kind: "content"; readonly index: number }
	| { readonly kind: "zone"; readonly zoneKey: string; readonly index: number };

/**
 * Map every descendant node id to the TOP-LEVEL Puck item (root
 * content slot or a `zones[...]` slot) whose subtree contains it —
 * that is the minimal unit a non-structural prop edit must replace.
 * Cached per `Data` object: the converted data is immutable for the
 * lifetime of a dispatch and re-indexing it is wasted work.
 */
const indexCache = new WeakMap<object, Map<string, OwnerLocation>>();

function collectItemIds(item: PuckContentItem, into: Set<string>): void {
	const props = (item as { props?: Record<string, unknown> }).props;
	if (!props) return;
	const id = props.id;
	if (typeof id === "string") into.add(id);
	for (const value of Object.values(props)) {
		if (Array.isArray(value)) {
			for (const nested of value) {
				if (nested && typeof nested === "object" && "props" in nested) {
					collectItemIds(nested as PuckContentItem, into);
				}
			}
		}
	}
}

export function buildNodeLocationIndex(
	data: ProjectionData,
): Map<string, OwnerLocation> {
	const cached = indexCache.get(data as object);
	if (cached) return cached;

	const index = new Map<string, OwnerLocation>();
	const addOwner = (item: PuckContentItem, owner: OwnerLocation): void => {
		const ids = new Set<string>();
		collectItemIds(item, ids);
		for (const id of ids) index.set(id, owner);
	};

	const content = data.content ?? [];
	for (let i = 0; i < content.length; i += 1) {
		const item = content[i];
		if (item) addOwner(item, { kind: "content", index: i });
	}
	const zones = data.zones ?? {};
	for (const zoneKey of Object.keys(zones)) {
		const arr = zones[zoneKey] ?? [];
		for (let i = 0; i < arr.length; i += 1) {
			const item = arr[i];
			if (item) addOwner(item, { kind: "zone", zoneKey, index: i });
		}
	}

	indexCache.set(data as object, index);
	return index;
}

/** True if `node` or any descendant is a zone-kind child. */
function subtreeHasZone(node: PageIRNodeWithSlots): boolean {
	for (const child of node.children ?? []) {
		if (child.slotKind === "zone") return true;
		if (subtreeHasZone(child)) return true;
	}
	return false;
}

/**
 * Single-node IR→Puck content-item builder. A faithful copy of
 * `irToPuckData`'s `nodeToContent` for the zone-free case — callers
 * MUST gate on `!subtreeHasZone(node)` so the zones side-effect
 * branch is unreachable, keeping output identical to the full
 * round-trip without a shared zones map.
 */
function nodeToContentItem(node: PageIRNodeWithSlots): PuckContentItem {
	const props: Record<string, unknown> = {
		id: node.id,
		...(node.props as Record<string, unknown>),
	};
	for (const child of node.children ?? []) {
		const childContent = nodeToContentItem(child);
		const slotName = child.slot ?? DEFAULT_NESTED_SLOT;
		const existing = props[slotName];
		props[slotName] = [
			...(Array.isArray(existing) ? (existing as PuckContentItem[]) : []),
			childContent,
		];
	}
	return { type: node.type, props } as PuckContentItem;
}

function indexIRNodes(
	root: PageIRNodeWithSlots,
	into: Map<string, PageIRNodeWithSlots>,
): void {
	into.set(root.id, root);
	for (const child of root.children ?? []) indexIRNodes(child, into);
}

/**
 * Produce post-edit Puck data from `before` by recomputing only the
 * owner item(s) of the changed ids. Returns `null` to signal the
 * caller should fall back to `irToPuckData(fullIR)`.
 */
export function projectChangedNodes(
	before: ProjectionData,
	ir: PageIR,
	changedIds: ReadonlySet<string>,
): ProjectionData | null {
	if (changedIds.size === 0) return before;

	const irRoot = ir.root as PageIRNodeWithSlots;
	// A change to the root node itself touches root.props — out of
	// this fast path's scope (kept rare; full conversion handles it).
	if (changedIds.has(irRoot.id)) return null;

	const locIndex = buildNodeLocationIndex(before);
	const irById = new Map<string, PageIRNodeWithSlots>();
	indexIRNodes(irRoot, irById);

	// Resolve the distinct top-level owners that must be recomputed.
	const ownersToRebuild = new Map<string, OwnerLocation>();
	for (const id of changedIds) {
		const loc = locIndex.get(id);
		if (loc === undefined) return null; // unknown id → structural; bail
		// Owner's own id: content/zone item's props.id at that slot.
		const key =
			loc.kind === "content"
				? `c:${loc.index}`
				: `z:${loc.zoneKey}:${loc.index}`;
		ownersToRebuild.set(key, loc);
	}

	// Shallow-clone only the arrays we will mutate; everything else
	// keeps identity so the planner treats it as unchanged for free.
	const nextContent: PuckContentItem[] = [...(before.content ?? [])];
	const next = {
		...before,
		content: nextContent,
	} as {
		content: PuckContentItem[];
		zones?: Record<string, PuckContentItem[]>;
		root?: unknown;
	};
	let nextZones: Record<string, PuckContentItem[]> | undefined;
	if (before.zones) {
		nextZones = {};
		for (const k of Object.keys(before.zones)) {
			nextZones[k] = [...(before.zones[k] ?? [])];
		}
		next.zones = nextZones;
	}

	for (const loc of ownersToRebuild.values()) {
		const arr = loc.kind === "content" ? nextContent : nextZones?.[loc.zoneKey];
		if (!arr) return null;
		const beforeItem = arr[loc.index] as
			| { props?: { id?: unknown } }
			| undefined;
		const ownerId = beforeItem?.props?.id;
		if (typeof ownerId !== "string") return null;
		const irOwner = irById.get(ownerId);
		// Owner gone, relocated, or carries zone children → structural
		// or shared-zones territory: defer to the full round-trip.
		if (irOwner === undefined || subtreeHasZone(irOwner)) return null;
		arr[loc.index] = nodeToContentItem(irOwner);
	}

	return next;
}
