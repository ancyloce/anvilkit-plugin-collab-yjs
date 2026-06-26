import type {
	PeerInfo,
	PresenceCursor,
	PresenceSelection,
	PresenceState,
	SnapshotAdapterPresence,
	Unsubscribe,
} from "@anvilkit/plugin-version-history";

/**
 * Structured validation for `PresenceState` payloads. Replaces the
 * scattered ad-hoc type guards previously inline in `yjs-adapter.ts`.
 *
 * `validate*` returns the strongly-typed value when the input matches the
 * schema, or `null` when it does not. Hosts can use these helpers to
 * sanitize awareness payloads received over an untrusted transport.
 *
 * Hardening (M4):
 *
 * - `displayName` is capped at `MAX_DISPLAY_NAME_LENGTH` chars and stripped
 *   of ASCII control characters by `sanitizeDisplayName`. Bytes that don't
 *   match are filtered out — the result is the validated payload with a
 *   sanitized name, not a rejection of the whole record.
 * - `color` is validated against an allowlist regex covering `#rgb`,
 *   `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, `hsl(...)`,
 *   `hsla(...)`, and the
 *   `NAMED_COLOR_SET`. Anything else (notably `javascript:`,
 *   `expression(...)`, `<script>`, or arbitrary strings) is treated as
 *   schema failure and rejects the peer record entirely. Hosts that
 *   render `color` into a CSS attribute therefore get defense-in-depth
 *   without doing their own validation.
 */

export const MAX_DISPLAY_NAME_LENGTH = 64;

const COLOR_REGEX =
	/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)|hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)|hsla\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*,\s*(0|1|0?\.\d+)\s*\))$/;

const NAMED_COLOR_SET = new Set([
	"transparent",
	"currentcolor",
	"black",
	"white",
	"red",
	"green",
	"blue",
	"yellow",
	"orange",
	"purple",
	"pink",
	"gray",
	"grey",
	"brown",
	"cyan",
	"magenta",
	"lime",
	"navy",
	"teal",
	"olive",
	"maroon",
	"silver",
	"gold",
	"indigo",
	"violet",
]);

function isValidColor(value: string): boolean {
	if (value.length === 0 || value.length > 32) return false;
	if (COLOR_REGEX.test(value)) return true;
	return NAMED_COLOR_SET.has(value.toLowerCase());
}

/**
 * Strip ASCII control characters (and the DEL byte) from a display name,
 * then cap to `MAX_DISPLAY_NAME_LENGTH`. Does NOT escape HTML — hosts
 * that render the name into `innerHTML` must still apply their own
 * escaping; this helper only blunts the control-character injection sink.
 */
export function sanitizeDisplayName(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this helper's purpose is to strip those exact characters
	const stripped = value.replace(/[\u0000-\u001f\u007f]/g, "");
	if (stripped.length <= MAX_DISPLAY_NAME_LENGTH) return stripped;
	return stripped.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

export function validatePeerInfo(value: unknown): PeerInfo | null {
	if (!isObject(value)) return null;
	if (typeof value.id !== "string" || value.id.length === 0) return null;
	if (value.displayName !== undefined) {
		if (typeof value.displayName !== "string") return null;
	}
	if (value.color !== undefined) {
		if (typeof value.color !== "string") return null;
		if (!isValidColor(value.color)) return null;
	}
	const sanitized: Record<string, unknown> = { id: value.id };
	if (typeof value.displayName === "string") {
		sanitized.displayName = sanitizeDisplayName(value.displayName);
	}
	if (typeof value.color === "string") sanitized.color = value.color;
	return sanitized as unknown as PeerInfo;
}

export function validatePresenceCursor(value: unknown): PresenceCursor | null {
	if (!isObject(value)) return null;
	if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
	return value as unknown as PresenceCursor;
}

export function validatePresenceSelection(
	value: unknown,
): PresenceSelection | null {
	if (!isObject(value)) return null;
	const { nodeIds } = value;
	if (!Array.isArray(nodeIds)) return null;
	if (!nodeIds.every((id) => typeof id === "string")) return null;
	return value as unknown as PresenceSelection;
}

/**
 * Current presence payload schema version (§4.2.5).
 *
 * Payloads with no `version` field (or `version <= 1`) are legacy
 * cursor/single-or-array-selection-only states and remain valid — the
 * richer fields are simply absent. New hosts stamp this value so peers
 * can feature-detect the extended fields without breaking older clients.
 */
export const PRESENCE_SCHEMA_VERSION = 2;

/**
 * Upper bound on the number of node ids carried in a multi-select
 * presence payload. A hostile/buggy peer that "select-all"s a huge
 * document must not be able to flood every other client's awareness
 * cache with an unbounded id array — excess ids beyond this cap are
 * dropped (the selection is truncated, not the whole state rejected).
 */
export const MAX_SELECTION_IDS = 256;

/**
 * Upper bound on the length of a single node-id / focused-block-id
 * string. Mirrors {@link MAX_DISPLAY_NAME_LENGTH} in spirit — keeps a
 * peer from smuggling a megabyte string through an id field.
 */
export const MAX_NODE_ID_LENGTH = 256;

/**
 * Clamp range for `viewport.zoom`. Values outside the range are clamped
 * (not rejected) so a peer mid-gesture with a transient out-of-range
 * zoom still produces a usable viewport.
 */
export const MIN_VIEWPORT_ZOOM = 0.01;
export const MAX_VIEWPORT_ZOOM = 256;

/**
 * Peer viewport — scroll offset, zoom factor, and an optional visible
 * rect. Lets remote clients render "where is this peer looking"
 * follow-along UI. All numbers are finite; `zoom`/`width`/`height` are
 * clamped to sane bounds by {@link validatePresenceViewport}.
 */
export interface PresenceViewport {
	/** Horizontal scroll offset (document px). */
	readonly x: number;
	/** Vertical scroll offset (document px). */
	readonly y: number;
	/** Zoom factor, clamped to [{@link MIN_VIEWPORT_ZOOM}, {@link MAX_VIEWPORT_ZOOM}]. */
	readonly zoom: number;
	/** Optional visible-rect width (document px, clamped ≥ 0). */
	readonly width?: number;
	/** Optional visible-rect height (document px, clamped ≥ 0). */
	readonly height?: number;
}

/**
 * Activity / typing metadata for a peer. Lets hosts render "Alice is
 * typing…" affordances. Both fields are optional and individually
 * validated.
 */
export interface PresenceActivity {
	/** Whether the peer is actively typing / editing. */
	readonly typing?: boolean;
	/** Epoch-ms timestamp of the last activity tick (finite, clamped ≥ 0). */
	readonly updatedAt?: number;
}

/**
 * Versioned, backward-compatible superset of {@link PresenceState}
 * (§4.2.5). Every richer field is optional, so a plain `PresenceState`
 * is a valid `RichPresenceState` and vice versa. Multi-select reuses the
 * existing `selection.nodeIds` array (which already permits many ids);
 * the additions are viewport, focused-block, activity, and the schema
 * `version`.
 */
export interface RichPresenceState extends PresenceState {
	/** Schema version of this payload. Absent ⇒ legacy (≤ 1). */
	readonly version?: number;
	/** Peer viewport (scroll + zoom, optional visible rect). */
	readonly viewport?: PresenceViewport;
	/** Currently focused block id (e.g. the field/block under edit). */
	readonly focusedId?: string;
	/** Activity / typing metadata. */
	readonly activity?: PresenceActivity;
}

/**
 * Richer-typed view of {@link SnapshotAdapterPresence} (§4.2.5). Same
 * runtime object — `update` accepts and `onPeerChange` emits
 * {@link RichPresenceState}, so hosts can set and read the versioned
 * multi-select / viewport / focused-block / typing fields while the base
 * cursor + selection contract keeps working. Structurally assignable to
 * `SnapshotAdapterPresence` (the extra fields are optional).
 */
export interface RichSnapshotAdapterPresence extends SnapshotAdapterPresence {
	update(state: RichPresenceState): void;
	onPeerChange(
		callback: (peers: readonly RichPresenceState[]) => void,
	): Unsubscribe;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isValidNodeId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_NODE_ID_LENGTH
	);
}

/**
 * Validate a finite number and clamp it to `[min, max]`. Returns `null`
 * for non-numbers and non-finite values (NaN/±Infinity) so the caller
 * can reject the field.
 */
function clampFiniteNumber(
	value: unknown,
	min: number,
	max: number,
): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

/**
 * Sanitizing variant of {@link validatePresenceSelection} used by the
 * rich presence path (§4.2.5). Unlike the strict validator — which
 * rejects the whole selection on any non-string entry — this DROPS
 * individual bad ids (non-string, empty, or over-long) and truncates the
 * array to {@link MAX_SELECTION_IDS}. Returns `null` only when `nodeIds`
 * is absent or not an array.
 */
export function sanitizePresenceSelection(
	value: unknown,
): PresenceSelection | null {
	if (!isObject(value)) return null;
	const { nodeIds } = value;
	if (!Array.isArray(nodeIds)) return null;
	const sanitized: string[] = [];
	for (const id of nodeIds) {
		if (sanitized.length >= MAX_SELECTION_IDS) break;
		if (isValidNodeId(id)) sanitized.push(id);
	}
	return { nodeIds: sanitized };
}

/**
 * Validate a {@link PresenceViewport}. Requires finite `x`/`y`; clamps
 * `zoom` to the {@link MIN_VIEWPORT_ZOOM}..{@link MAX_VIEWPORT_ZOOM}
 * range and any provided `width`/`height` to ≥ 0. Returns `null` (field
 * rejected) when a required number is missing/non-finite. Returns a
 * fresh object carrying only the known fields (forward-compatible: a
 * future peer's extra sub-fields are dropped, not preserved).
 */
export function validatePresenceViewport(
	value: unknown,
): PresenceViewport | null {
	if (!isObject(value)) return null;
	if (typeof value.x !== "number" || !Number.isFinite(value.x)) return null;
	if (typeof value.y !== "number" || !Number.isFinite(value.y)) return null;
	const zoom = clampFiniteNumber(
		value.zoom,
		MIN_VIEWPORT_ZOOM,
		MAX_VIEWPORT_ZOOM,
	);
	if (zoom === null) return null;
	const result: Mutable<PresenceViewport> = { x: value.x, y: value.y, zoom };
	if (value.width !== undefined) {
		const width = clampFiniteNumber(value.width, 0, Number.MAX_SAFE_INTEGER);
		if (width === null) return null;
		result.width = width;
	}
	if (value.height !== undefined) {
		const height = clampFiniteNumber(value.height, 0, Number.MAX_SAFE_INTEGER);
		if (height === null) return null;
		result.height = height;
	}
	return result;
}

/**
 * Validate {@link PresenceActivity}. `typing` must be a boolean when
 * present; `updatedAt` must be a finite number (clamped ≥ 0). Returns a
 * fresh object with only the known fields, or `null` when a present
 * field is malformed.
 */
export function validatePresenceActivity(
	value: unknown,
): PresenceActivity | null {
	if (!isObject(value)) return null;
	const result: Mutable<PresenceActivity> = {};
	if (value.typing !== undefined) {
		if (typeof value.typing !== "boolean") return null;
		result.typing = value.typing;
	}
	if (value.updatedAt !== undefined) {
		const updatedAt = clampFiniteNumber(
			value.updatedAt,
			0,
			Number.MAX_SAFE_INTEGER,
		);
		if (updatedAt === null) return null;
		result.updatedAt = updatedAt;
	}
	return result;
}

/**
 * Validate a full presence payload (§4.2.5).
 *
 * Reconstructs a sanitized {@link RichPresenceState} carrying only the
 * KNOWN fields (an allowlist) — a hostile peer therefore cannot smuggle
 * arbitrary top-level keys into the local view. Backward compatible:
 *
 * - The `selection` field is sanitized via {@link sanitizePresenceSelection}
 *   so a multi-select array is bounded and bad ids are dropped rather
 *   than rejecting the whole peer.
 * - The richer fields (`version`, `viewport`, `focusedId`, `activity`)
 *   are optional — a legacy single-selection peer with none of them
 *   still validates. A field that is PRESENT but malformed rejects the
 *   whole state (defense-in-depth, consistent with the existing
 *   cursor/selection handling).
 */
export function validatePresenceState(
	value: unknown,
): RichPresenceState | null {
	if (!isObject(value)) return null;
	const peer = validatePeerInfo(value.peer);
	if (peer === null) return null;

	const result: Mutable<RichPresenceState> = { peer };

	if (value.cursor !== undefined) {
		const cursor = validatePresenceCursor(value.cursor);
		if (cursor === null) return null;
		result.cursor = cursor;
	}
	if (value.selection !== undefined) {
		const selection = sanitizePresenceSelection(value.selection);
		if (selection === null) return null;
		result.selection = selection;
	}
	if (value.viewport !== undefined) {
		const viewport = validatePresenceViewport(value.viewport);
		if (viewport === null) return null;
		result.viewport = viewport;
	}
	if (value.focusedId !== undefined) {
		if (!isValidNodeId(value.focusedId)) return null;
		result.focusedId = value.focusedId;
	}
	if (value.activity !== undefined) {
		const activity = validatePresenceActivity(value.activity);
		if (activity === null) return null;
		result.activity = activity;
	}
	if (value.version !== undefined) {
		const version = clampFiniteNumber(
			value.version,
			0,
			Number.MAX_SAFE_INTEGER,
		);
		if (version === null) return null;
		result.version = version;
	}
	return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
