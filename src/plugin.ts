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

const FALLBACK_LOCAL_PEER: PeerInfo = { id: "local" };

const META = {
	id: "anvilkit-plugin-collab-yjs",
	name: "Collab (Yjs)",
	version: "0.9.0-rc.0",
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
 */
export function createCollabPlugin(
	options: CreateCollabPluginOptions,
): StudioPlugin {
	let unsubscribe: (() => void) | undefined;
	const pendingRemoteDataKeys: string[] = [];

	return {
		meta: META,
		register(_ctx) {
			const registration: StudioPluginRegistration = {
				meta: META,
				hooks: {
					async onInit(initCtx) {
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
								pendingRemoteDataKeys,
								options,
								peer,
							);
						});
						await hydrateLatestSnapshot(
							initCtx,
							options,
							pendingRemoteDataKeys,
						);
					},
					onDataChange(changeCtx, data) {
						if (consumePendingRemoteData(data, pendingRemoteDataKeys)) {
							return;
						}
						if (!options.puckConfig) return;
						const ir = puckDataToIR(data, options.puckConfig);
						const localPeer = options.localPeer ?? FALLBACK_LOCAL_PEER;
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
						options.adapter.save(ir, {});
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
	pendingRemoteDataKeys: string[],
): Promise<void> {
	try {
		const snapshots = await Promise.resolve(options.adapter.list());
		const latest = snapshots.at(-1);
		if (!latest) return;
		const ir = await Promise.resolve(options.adapter.load(latest.id));
		dispatchRemoteIR(ctx, ir, pendingRemoteDataKeys, options);
	} catch (error) {
		ctx.log("warn", "plugin-collab-yjs: initial hydrate failed.", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function dispatchRemoteIR(
	ctx: StudioPluginContext,
	ir: PageIR,
	pendingRemoteDataKeys: string[],
	options: CreateCollabPluginOptions,
	peer?: PeerInfo,
): void {
	const validated = runValidation(ctx, ir, options);
	if (validated === null) return;
	const checkedPeer = peer ?? options.localPeer ?? FALLBACK_LOCAL_PEER;
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
	pendingRemoteDataKeys.push(stableStringify(data));
	try {
		ctx.getPuckApi().dispatch({ type: "setData", data });
	} catch (error) {
		pendingRemoteDataKeys.pop();
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
	walkNodes(ir.root, (node) => {
		try {
			if (!policy.canEdit(node, peer)) rejected.push(node.id);
		} catch (error) {
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
	pendingRemoteDataKeys: string[],
): boolean {
	const key = stableStringify(data);
	const index = pendingRemoteDataKeys.indexOf(key);
	if (index === -1) return false;
	pendingRemoteDataKeys.splice(index, 1);
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

export type { CreateCollabPluginOptions } from "./types.js";
