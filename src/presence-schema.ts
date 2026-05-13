import type {
	PeerInfo,
	PresenceCursor,
	PresenceSelection,
	PresenceState,
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
 *   `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, and the
 *   `NAMED_COLOR_SET`. Anything else (notably `javascript:`,
 *   `expression(...)`, `<script>`, or arbitrary strings) is treated as
 *   schema failure and rejects the peer record entirely. Hosts that
 *   render `color` into a CSS attribute therefore get defense-in-depth
 *   without doing their own validation.
 */

export const MAX_DISPLAY_NAME_LENGTH = 64;

const COLOR_REGEX =
	/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/;

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

export function validatePresenceState(value: unknown): PresenceState | null {
	if (!isObject(value)) return null;
	if (validatePeerInfo(value.peer) === null) return null;
	if (
		value.cursor !== undefined &&
		validatePresenceCursor(value.cursor) === null
	) {
		return null;
	}
	if (
		value.selection !== undefined &&
		validatePresenceSelection(value.selection) === null
	) {
		return null;
	}
	return value as unknown as PresenceState;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
