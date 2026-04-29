import type { PageIR } from "@anvilkit/core/types";
import type {
	PeerInfo,
	SnapshotAdapter,
} from "@anvilkit/plugin-version-history";
import type { Config } from "@puckeditor/core";
import type { Awareness } from "y-protocols/awareness";
import type { Doc as YDoc } from "yjs";

export interface CreateYjsAdapterOptions {
	readonly doc: YDoc;
	readonly awareness?: Awareness;
	readonly peer?: PeerInfo;
	readonly mapName?: string;
}

export interface CreateCollabPluginOptions {
	readonly adapter: SnapshotAdapter;
	readonly puckConfig?: Config;
}

export interface CollabPluginRuntime {
	readonly currentIR: () => PageIR | undefined;
}
