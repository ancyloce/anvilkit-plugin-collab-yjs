import type {
	PageIR,
	StudioPlugin,
	StudioPluginContext,
	StudioPluginRegistration,
} from "@anvilkit/core/types";
import { irToPuckData, puckDataToIR } from "@anvilkit/ir";

import type { CreateCollabPluginOptions } from "./types.js";

const META = {
	id: "anvilkit-plugin-collab-yjs",
	name: "Collab (Yjs alpha)",
	version: "0.1.0-alpha.0",
	coreVersion: "^0.1.0-alpha",
	description:
		"Alpha-channel realtime collaboration for Anvilkit Studio over a Yjs CRDT transport. Implements the SnapshotAdapter v2 contract.",
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
						unsubscribe = options.adapter.subscribe((ir) => {
							dispatchRemoteIR(initCtx, ir, pendingRemoteDataKeys);
						});
						await hydrateLatestSnapshot(
							initCtx,
							options,
							pendingRemoteDataKeys,
						);
					},
					onDataChange(_changeCtx, data) {
						if (consumePendingRemoteData(data, pendingRemoteDataKeys)) {
							return;
						}
						if (!options.puckConfig) return;
						const ir = puckDataToIR(data, options.puckConfig);
						options.adapter.save(ir, {});
					},
					onDestroy() {
						if (unsubscribe) {
							unsubscribe();
							unsubscribe = undefined;
						}
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
		dispatchRemoteIR(ctx, ir, pendingRemoteDataKeys);
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
): void {
	const data = irToPuckData(ir);
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
