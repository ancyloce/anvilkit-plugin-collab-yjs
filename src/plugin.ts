import type {
	PageIR,
	PageIRNode,
	StudioPlugin,
	StudioPluginContext,
	StudioPluginRegistration,
} from "@anvilkit/core/types";
import { irToPuckData, puckDataToIR } from "@anvilkit/ir";
import type { PeerInfo } from "@anvilkit/plugin-version-history";

import type {
	CollabPolicy,
	CreateCollabPluginOptions,
	PolicyViolation,
	ValidationFailure,
} from "./types.js";

/**
 * Per-instance fallback peer id used when `options.localPeer` is omitted.
 *
 * The previous `{ id: "local" }` constant collided across every client
 * that omitted `localPeer` — `isLocalOrigin` then treated remote
 * transactions as local-origin and suppressed remote dispatch entirely.
 * Each plugin instance now mints its own ephemeral id so a missing
 * `localPeer` degrades to single-user-warned rather than silently
 * collapsing multi-peer sessions to one fake user.
 */
function createEphemeralPeer(): PeerInfo {
	const uuid =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: Math.random().toString(36).slice(2, 10);
	return { id: `local-${uuid}` };
}

interface PendingRemoteEntry {
	count: number;
	addedAt: number;
}

const PENDING_REMOTE_MAX_AGE_MS = 60_000;

function sweepPendingRemoteData(
	pending: Map<string, PendingRemoteEntry>,
	now: number,
): void {
	for (const [key, entry] of pending) {
		if (now - entry.addedAt > PENDING_REMOTE_MAX_AGE_MS) pending.delete(key);
	}
}

const META = {
	id: "anvilkit-plugin-collab-yjs",
	name: "Collab (Yjs)",
	version: "0.9.0-rc.1",
	coreVersion: "^0.1.0-alpha",
	description:
		"GA-candidate realtime collaboration for Anvilkit Studio over a Yjs CRDT transport. Implements the SnapshotAdapter v2 contract with conflict diagnostics, validation, debouncing, an opt-in native Y.Map IR tree for per-node merge, a transport-agnostic connection-state contract, and force-resync.",
} as const;

/**
 * Create a Studio plugin that wires a SnapshotAdapter v2 (typically
 * built with `createYjsAdapter`) into the editor lifecycle.
 *
 * Incoming side (remote → local): the plugin observes the adapter's
 * `subscribe()` callback and dispatches `setData` with `irToPuckData`
 * so Puck remains the single source of truth for the canvas.
 *
 * Outgoing side (local → remote): on every Puck `onChange`, the
 * plugin reads the new data, converts it back to IR via
 * `puckDataToIR`, and persists via the adapter's `save()`. Outgoing
 * sync only runs when `puckConfig` is supplied — keeping it optional
 * means a host can defer the wiring to the application layer if it
 * needs custom IR canonicalization.
 *
 * ### Naming
 *
 * This factory used to be exported as `createCollabPlugin`. The new
 * `@anvilkit/plugin-collab-ui` package exposes a higher-level
 * `createCollabPlugin` that bundles the data plugin together with the
 * UI providers/overlays/slots. Inside this package the data-only
 * factory is therefore renamed `createCollabDataPlugin` to
 * disambiguate. The legacy export `createCollabPlugin` is still
 * available as a deprecated alias for one minor release.
 */
export function createCollabDataPlugin(
	options: CreateCollabPluginOptions,
): StudioPlugin {
	let unsubscribe: (() => void) | undefined;
	const pendingRemoteData = new Map<string, PendingRemoteEntry>();
	const ephemeralPeer = options.localPeer ?? createEphemeralPeer();
	const usedEphemeralPeer = options.localPeer === undefined;

	return {
		meta: META,
		register(_ctx) {
			const registration: StudioPluginRegistration = {
				meta: META,
				hooks: {
					async onInit(initCtx) {
						if (usedEphemeralPeer) {
							initCtx.log(
								"warn",
								"plugin-collab-yjs: options.localPeer omitted; generated ephemeral id. Provide a stable id for production.",
								{ id: ephemeralPeer.id },
							);
						}
						if (typeof options.adapter.subscribe !== "function") {
							initCtx.log(
								"warn",
								"plugin-collab-yjs: adapter has no subscribe() method; incoming sync disabled.",
							);
							return;
						}
						unsubscribe = options.adapter.subscribe((ir, peer) => {
							dispatchRemoteIR(
								initCtx,
								ir,
								pendingRemoteData,
								options,
								ephemeralPeer,
								peer,
							);
						});
						await hydrateLatestSnapshot(
							initCtx,
							options,
							pendingRemoteData,
							ephemeralPeer,
						);
					},
					onDataChange(changeCtx, data) {
						if (consumePendingRemoteData(data, pendingRemoteData)) {
							return;
						}
						if (!options.puckConfig) return;
						const ir = puckDataToIR(data, options.puckConfig);
						const localPeer = ephemeralPeer;
						const violation = enforcePolicy(
							ir,
							localPeer,
							options.policy,
							"outbound",
						);
						if (violation) {
							changeCtx.log(
								"warn",
								"plugin-collab-yjs: outbound save blocked by policy.canEdit.",
								{ nodeIds: violation.nodeIds },
							);
							options.onPolicyViolation?.(violation);
							return;
						}
						try {
							const result = options.adapter.save(ir, {});
							Promise.resolve(result).catch((error: unknown) => {
								changeCtx.log(
									"error",
									"plugin-collab-yjs: outbound save failed.",
									{
										error:
											error instanceof Error ? error.message : String(error),
									},
								);
								options.onSaveError?.(error);
							});
						} catch (error) {
							changeCtx.log(
								"error",
								"plugin-collab-yjs: outbound save threw synchronously.",
								{
									error: error instanceof Error ? error.message : String(error),
								},
							);
							options.onSaveError?.(error);
						}
					},
					onDestroy() {
						if (unsubscribe) {
							unsubscribe();
							unsubscribe = undefined;
						}
						const { destroy } = options.adapter as {
							destroy?: () => void;
						};
						destroy?.();
					},
				},
			};
			return registration;
		},
	};
}

async function hydrateLatestSnapshot(
	ctx: StudioPluginContext,
	options: CreateCollabPluginOptions,
	pendingRemoteData: Map<string, PendingRemoteEntry>,
	localPeer: PeerInfo,
): Promise<void> {
	try {
		const snapshots = await Promise.resolve(options.adapter.list());
		const latest = snapshots.at(-1);
		if (!latest) return;
		const ir = await Promise.resolve(options.adapter.load(latest.id));
		dispatchRemoteIR(ctx, ir, pendingRemoteData, options, localPeer);
	} catch (error) {
		ctx.log("warn", "plugin-collab-yjs: initial hydrate failed.", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function dispatchRemoteIR(
	ctx: StudioPluginContext,
	ir: PageIR,
	pendingRemoteData: Map<string, PendingRemoteEntry>,
	options: CreateCollabPluginOptions,
	localPeer: PeerInfo,
	peer?: PeerInfo,
): void {
	const validated = runValidation(ctx, ir, options);
	if (validated === null) return;
	const checkedPeer = peer ?? localPeer;
	const violation = enforcePolicy(
		validated,
		checkedPeer,
		options.policy,
		"inbound",
	);
	if (violation) {
		ctx.log(
			"warn",
			"plugin-collab-yjs: inbound dispatch blocked by policy.canEdit.",
			{ nodeIds: violation.nodeIds },
		);
		options.onPolicyViolation?.(violation);
		return;
	}
	const data = irToPuckData(validated);
	const key = stableStringify(data);
	// Skip the dispatch when the resulting Puck data is structurally
	// identical to what Puck already holds. This eliminates two
	// classes of spurious re-render that would otherwise reset
	// focused controlled inputs (cursor jumps in <textarea>):
	//   - server echo of the local peer's own writes coming back
	//     through the relay
	//   - CRDT merges where the remote update did not change anything
	//     the host actually renders (e.g. internal metadata churn)
	// Reading current data via `ctx.getData()` instead of
	// `getPuckApi().appState` keeps this path off Puck's API when the
	// plugin context is configured without a live `<Puck>` mount
	// (tests, headless validation).
	let currentKey: string | undefined;
	try {
		currentKey = stableStringify(ctx.getData());
	} catch {
		// `getData` shouldn't throw, but if a host implementation does,
		// fall through to the dispatch path rather than swallow the
		// remote update silently.
		currentKey = undefined;
	}
	if (currentKey !== undefined && currentKey === key) return;
	const now = Date.now();
	sweepPendingRemoteData(pendingRemoteData, now);
	const existing = pendingRemoteData.get(key);
	if (existing) {
		existing.count += 1;
		existing.addedAt = now;
	} else {
		pendingRemoteData.set(key, { count: 1, addedAt: now });
	}
	try {
		ctx.getPuckApi().dispatch({ type: "setData", data });
	} catch (error) {
		// Roll back the speculative count bump since the echo never made it
		// into Puck's pipeline and no matching onDataChange will arrive.
		const rollback = pendingRemoteData.get(key);
		if (rollback) {
			if (rollback.count <= 1) pendingRemoteData.delete(key);
			else rollback.count -= 1;
		}
		ctx.log("error", "plugin-collab-yjs: remote update dispatch failed.", {
			error,
		});
	}
}

function enforcePolicy(
	ir: PageIR,
	peer: PeerInfo,
	policy: CollabPolicy | undefined,
	direction: "inbound" | "outbound",
): PolicyViolation | undefined {
	if (!policy) return undefined;
	const rejected: string[] = [];
	let failureError: unknown;
	// Memoize canEdit per (node.id, peer.id) for the duration of this
	// single enforcePolicy call. Two adjacent calls on the same IR
	// (e.g. inbound + outbound checks in the same dispatch round) each
	// get their own cache — we deliberately do NOT cache cross-call so
	// policy state changes between calls always take effect (M5).
	const cache = new Map<string, boolean>();
	walkNodes(ir.root, (node) => {
		const cacheKey = `${node.id}::${peer.id}`;
		const cached = cache.get(cacheKey);
		if (cached !== undefined) {
			if (!cached) rejected.push(node.id);
			return;
		}
		try {
			const allowed = policy.canEdit(node, peer);
			cache.set(cacheKey, allowed);
			if (!allowed) rejected.push(node.id);
		} catch (error) {
			cache.set(cacheKey, false);
			failureError = error;
			rejected.push(node.id);
		}
	});
	if (rejected.length === 0) return undefined;
	return {
		direction,
		nodeIds: rejected,
		peer,
		error: failureError,
	};
}

function walkNodes(node: PageIRNode, visit: (node: PageIRNode) => void): void {
	visit(node);
	if (node.children) for (const child of node.children) walkNodes(child, visit);
}

function runValidation(
	ctx: StudioPluginContext,
	ir: PageIR,
	options: CreateCollabPluginOptions,
): PageIR | null {
	if (!options.validateRemoteIR) return ir;
	let failure: ValidationFailure | undefined;
	try {
		const result = options.validateRemoteIR(ir);
		if (result === null) {
			failure = { kind: "rejected" };
		} else {
			return result;
		}
	} catch (error) {
		failure = { kind: "threw", error };
	}
	if (failure) {
		ctx.log("warn", "plugin-collab-yjs: remote IR rejected by validator.", {
			kind: failure.kind,
			error:
				failure.error instanceof Error
					? failure.error.message
					: failure.error !== undefined
						? String(failure.error)
						: undefined,
		});
		options.onValidationFailure?.(failure);
	}
	return null;
}

function consumePendingRemoteData(
	data: unknown,
	pendingRemoteData: Map<string, PendingRemoteEntry>,
): boolean {
	sweepPendingRemoteData(pendingRemoteData, Date.now());
	const key = stableStringify(data);
	const entry = pendingRemoteData.get(key);
	if (!entry) return false;
	if (entry.count <= 1) pendingRemoteData.delete(key);
	else entry.count -= 1;
	return true;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, nested) => sortKeysIfObject(nested));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortKeysIfObject(value: unknown): unknown {
	if (!isObject(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = value[key];
	}
	return sorted;
}

/**
 * Module-scoped flag for the deprecation warning emitted by the
 * legacy {@link createCollabPlugin} alias. The warn fires at most once
 * per module instance (which, in practice, is once per process for
 * production consumers) so library code calling the alias in a hot
 * path does not flood the console.
 *
 * In tests, `vi.resetModules()` followed by a dynamic re-import
 * produces a fresh instance with this flag back to `false` — see
 * `plugin.alias-deprecation.test.ts`.
 */
let createCollabPluginDeprecationWarned = false;

/**
 * Deprecated alias for {@link createCollabDataPlugin}.
 *
 * The factory was renamed when `@anvilkit/plugin-collab-ui` introduced
 * a higher-level `createCollabPlugin` that bundles the data plugin with
 * UI contributions. Prefer {@link createCollabDataPlugin} for headless
 * / power-user paths.
 *
 * Emits a single `console.warn` on first call per module instance.
 * Will be removed in the next minor release of
 * `@anvilkit/plugin-collab-yjs`.
 *
 * @deprecated Use {@link createCollabDataPlugin} instead, or
 * `createCollabPlugin` from `@anvilkit/plugin-collab-ui` for the
 * full data + UI bundle.
 */
export function createCollabPlugin(
	options: CreateCollabPluginOptions,
): StudioPlugin {
	if (!createCollabPluginDeprecationWarned) {
		createCollabPluginDeprecationWarned = true;
		console.warn(
			"[@anvilkit/plugin-collab-yjs] `createCollabPlugin` is deprecated; use `createCollabDataPlugin` instead. " +
				"For the full data + UI bundle, import `createCollabPlugin` from `@anvilkit/plugin-collab-ui`. " +
				"The legacy alias will be removed in the next minor release.",
		);
	}
	return createCollabDataPlugin(options);
}

export type { CreateCollabPluginOptions } from "./types.js";
