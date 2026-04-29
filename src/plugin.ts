import type {
	StudioPlugin,
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
	let muteNextChange = false;

	return {
		meta: META,
		register(_ctx) {
			const registration: StudioPluginRegistration = {
				meta: META,
				hooks: {
					onInit(initCtx) {
						if (typeof options.adapter.subscribe !== "function") {
							initCtx.log(
								"warn",
								"plugin-collab-yjs: adapter has no subscribe() method; incoming sync disabled.",
							);
							return;
						}
						unsubscribe = options.adapter.subscribe((ir) => {
							muteNextChange = true;
							initCtx
								.getPuckApi()
								.dispatch({ type: "setData", data: irToPuckData(ir) });
						});
					},
					onDataChange(changeCtx, data) {
						if (muteNextChange) {
							muteNextChange = false;
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

export type { CreateCollabPluginOptions } from "./types.js";
