/**
 * A1 — single source of truth for the Puck-data structural shapes and
 * the `ROOT_DROPPABLE_ID` zone sentinel shared by `plugin.ts` (the
 * replace planner) and `incremental-projection.ts` (the O(changed)
 * projection). These were previously declared independently in both
 * files with a comment asserting they were "intentionally identical";
 * a divergence would have been a silent wrong-node corruption (the
 * projection's owner-resolution and the planner's zone matching would
 * disagree) because the comment is not machine-checked.
 *
 * The structural types stay deliberately loose (we only need
 * `content` / `zones` / `props.id`) so this module does NOT couple the
 * runtime to `@puckeditor/core`'s evolving generics. Instead, T2 — the
 * compile-time assertions below prove the loose shapes still line up
 * with `@puckeditor/core`, so a Puck `Data`/action rename (e.g. 0.21 →
 * 0.22) fails the build here instead of silently producing a malformed
 * `dispatch`.
 */

import type {
	PuckAction as PuckCoreAction,
	ComponentData as PuckCoreComponentData,
	Data as PuckCoreData,
} from "@puckeditor/core";

/** ROOT content zone sentinel — Puck's default-zone droppable id. */
export const ROOT_DROPPABLE_ID = "root:default-zone";

export type PuckContentItem = {
	readonly type: string;
	readonly props: Readonly<Record<string, unknown>> & { readonly id: string };
};

export type PuckData = {
	readonly content?: ReadonlyArray<PuckContentItem>;
	readonly zones?: Readonly<Record<string, ReadonlyArray<PuckContentItem>>>;
	readonly root?: unknown;
};

/**
 * Structural alias used by the incremental projection. Identical to
 * {@link PuckData} by construction (single declaration) — kept as a
 * named export so call sites read intently.
 */
export type ProjectionData = PuckData;

export type ReplaceAction = {
	readonly type: "replace";
	readonly destinationZone: string;
	readonly destinationIndex: number;
	readonly data: PuckContentItem;
};

// --- T2: compile-time Puck-shape drift detection ------------------
// `Assert<T extends true>` is a hard build error when its argument is
// not `true`, so each check fails `pnpm typecheck` the moment the
// corresponding `@puckeditor/core` shape stops lining up with the
// loose aliases this package dispatches against.
type Assert<_T extends true> = true;
type PuckCoreReplaceAction = Extract<PuckCoreAction, { type: "replace" }>;

// A real Puck `Data` must still be usable as our loose `PuckData`
// (content/zones/root), and a Puck `ComponentData` as our item shape.
type _AssertData = Assert<PuckCoreData extends PuckData ? true : false>;
type _AssertItem = Assert<
	PuckCoreComponentData extends PuckContentItem ? true : false
>;
// Puck's `replace` action must still carry the exact fields the
// planner sets; a field rename here breaks the build.
type _AssertReplace = Assert<
	PuckCoreReplaceAction extends {
		type: "replace";
		destinationZone: string;
		destinationIndex: number;
	}
		? true
		: false
>;

// Keep the assertions live (referenced) without emitting runtime code.
export type _PuckDriftChecks = [_AssertData, _AssertItem, _AssertReplace];
