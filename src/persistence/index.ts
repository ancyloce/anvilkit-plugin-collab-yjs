import type { PersistenceOptions } from "../types.js";
import {
	type BroadcastBridge,
	createBroadcastBridge,
} from "./broadcast-channel.js";
import { hasBroadcastChannel, hasIndexedDb } from "./feature-detect.js";
import { createIndexedDbBackend } from "./indexed-db.js";
import { createOfflineQueue, type OfflineQueue } from "./offline-queue.js";
import { createNullBackend, type StorageBackend } from "./storage-backend.js";

export interface PersistenceModule {
	readonly offlineQueue: OfflineQueue;
	readonly broadcastBridge: BroadcastBridge;
	readonly enabled: boolean;
	/** ISO marker that the host opted into either backend. */
	readonly hasDurableQueue: boolean;
	readonly hasCrossTabSync: boolean;
	/**
	 * Hydration promise. Resolves with the queued updates that need to
	 * be applied to the Y.Doc before the first `subscribe()` emission.
	 * Resolves to an empty array if persistence is disabled.
	 */
	readonly ready: Promise<readonly Uint8Array[]>;
	destroy(): void;
}

const DEFAULT_DB_NAME = "anvilkit-collab-yjs";
const DEFAULT_SCHEMA_VERSION = 1;

export interface CreatePersistenceOptions {
	readonly options: PersistenceOptions | undefined;
	readonly mapName: string;
	readonly onFault?: (reason: string) => void;
}

/**
 * Composes the persistence layer. Inspects `PersistenceOptions`,
 * runs feature-detection, and instantiates either real or no-op
 * backends. Always returns a fully-formed `PersistenceModule` so the
 * orchestrator can wire `doc.on("updateV2", ...)` without conditional
 * branches.
 */
export function createPersistence(
	input: CreatePersistenceOptions,
): PersistenceModule {
	const { options, mapName, onFault } = input;
	const wantsIndexedDb = options?.indexedDb === true;
	const wantsBroadcastChannel = options?.broadcastChannel === true;
	const dbName = options?.dbName ?? DEFAULT_DB_NAME;
	const schemaVersion = options?.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
	const channelName = options?.channelName ?? `${dbName}:${mapName}`;

	const hasDurableQueue = wantsIndexedDb && hasIndexedDb();
	const hasCrossTabSync = wantsBroadcastChannel && hasBroadcastChannel();

	let backend: StorageBackend = createNullBackend();
	let ready: Promise<readonly Uint8Array[]> = Promise.resolve([]);

	if (hasDurableQueue) {
		const pendingBackend = createIndexedDbBackend({
			dbName,
			schemaVersion,
			mapName,
			onFault,
		});
		ready = pendingBackend.then(async (resolvedBackend) => {
			backend = resolvedBackend;
			try {
				return await resolvedBackend.hydrate();
			} catch {
				return [];
			}
		});
	} else if (wantsIndexedDb) {
		onFault?.("indexed-db-feature-unavailable");
	}

	const offlineQueue = createOfflineQueue({
		getBackend: () => backend,
		ready: hasDurableQueue ? ready : undefined,
	});

	const broadcastBridge = hasCrossTabSync
		? createBroadcastBridge({ channelName, onFault })
		: createNullBroadcastBridge();
	if (wantsBroadcastChannel && !hasCrossTabSync) {
		onFault?.("broadcast-channel-feature-unavailable");
	}

	return {
		offlineQueue,
		broadcastBridge,
		enabled: hasDurableQueue || hasCrossTabSync,
		hasDurableQueue,
		hasCrossTabSync,
		ready,
		destroy(): void {
			offlineQueue.destroy();
			broadcastBridge.destroy();
		},
	};
}

function createNullBroadcastBridge(): BroadcastBridge {
	return {
		postUpdate(): void {
			// no-op
		},
		onRemoteUpdate(): () => void {
			return () => {
				// no-op
			};
		},
		instanceId: "",
		destroy(): void {
			// no-op
		},
	};
}
