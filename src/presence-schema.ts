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
 */

export function validatePeerInfo(value: unknown): PeerInfo | null {
	if (!isObject(value)) return null;
	if (typeof value.id !== "string" || value.id.length === 0) return null;
	if (value.displayName !== undefined && typeof value.displayName !== "string") {
		return null;
	}
	if (value.color !== undefined && typeof value.color !== "string") return null;
	return value as unknown as PeerInfo;
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
