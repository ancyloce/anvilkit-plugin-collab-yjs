/**
 * @file Managed collaboration transport for `@anvilkit/plugin-collab-yjs`.
 *
 * Exposed at the `@anvilkit/plugin-collab-yjs/transport` subpath (NOT from
 * the package barrel) so the provider libraries it lazily imports never get
 * pulled into a consumer's initial chunk.
 *
 * This is the layer below `createCollabPlugin()`: it owns the genuinely hard
 * part of "just give me collaboration" — constructing the `Y.Doc` +
 * `Awareness`, attaching the WebSocket provider, and bridging the provider's
 * connection events into the adapter's transport-agnostic
 * {@link ConnectionStatus} contract — so a host only sets a `websocketUrl`.
 *
 * Design (PRD 0001 §4.2): the factory returns **synchronously** — `new Y.Doc()`
 * and `new Awareness()` are cheap and `yjs` / `y-protocols` are already runtime
 * deps, so importing them at the top adds no new initial-chunk weight. Only the
 * **provider** is `await import()`-ed lazily, inside the returned
 * `connectionSource(emit)` which the adapter invokes synchronously on
 * construction (`utils/connection-status.ts`). `save()` writes land in the
 * `Y.Doc` immediately and replicate once the provider attaches, so the async
 * provider attach never blocks local editing.
 *
 * The provider-event → `ConnectionStatus` mappings and the Hocuspocus
 * "emit current state on attach" snapshot are **promoted verbatim** from the
 * demo's hand-written transport (`apps/demo/lib/collab-transport.ts`) — they
 * are already battle-tested; this module moves them, it does not rewrite them.
 */

import { Awareness } from "y-protocols/awareness";
import { Doc as YDoc } from "yjs";

import type { ConnectionSource, ConnectionStatus } from "./types/types.js";

/** Built-in managed-transport backends. */
export type ManagedTransportProvider = "hocuspocus" | "y-websocket";

export interface CreateManagedTransportOptions {
	/**
	 * WebSocket relay URL, e.g. `ws://localhost:1234`. Omit for single-tab
	 * in-memory mode (no provider; the doc is trivially in sync with itself).
	 */
	readonly websocketUrl?: string;
	/** Shared room/document name. Default `"anvilkit-default-room"`. */
	readonly room?: string;
	/** Backend to attach. Default `"hocuspocus"`. */
	readonly provider?: ManagedTransportProvider;
	/** Auth token forwarded to the relay (Hocuspocus `onAuthenticate`). Default `""`. */
	readonly token?: string;
	/**
	 * Bring-your-own `Awareness`. When omitted, the transport creates one
	 * (bound to its freshly-minted doc) and tears it down on
	 * {@link ManagedTransport.destroy}; when provided, it is reused and left
	 * for the host to dispose.
	 *
	 * Managed mode always creates its OWN `Y.Doc`, so a BYO awareness here is
	 * necessarily bound to a different doc. Presence is keyed by that doc's
	 * `clientID`, so only pass an awareness whose doc the host does not also
	 * render separately, or remote cursors may mis-attribute. Most managed-mode
	 * hosts should omit this and let the transport create it.
	 */
	readonly awareness?: Awareness;
	/** WebSocket implementation for non-browser hosts/tests (e.g. the `ws` package). */
	readonly WebSocketPolyfill?: unknown;
	/**
	 * Called when the transport fails (provider lib missing, bad URL, auth
	 * failure). Defaults to a single `console.error`. Never throws.
	 */
	readonly onConnectionError?: (err: unknown) => void;
}

export interface ManagedTransport {
	readonly doc: YDoc;
	readonly awareness: Awareness;
	/**
	 * Forward into `createYjsAdapter({ connectionSource })`. **Undefined in
	 * in-memory mode** (no relay URL): the adapter then auto-flips
	 * `connecting`→`synced` on first subscribe, matching the demo's in-memory
	 * transport. Emitting `synced` synchronously from a source here would run
	 * the adapter's `onSynced` before its snapshot module is constructed — a
	 * temporal-dead-zone crash during `<Studio>` mount.
	 */
	readonly connectionSource?: ConnectionSource;
	/** Tear down provider + (owned) awareness + doc. Idempotent. */
	destroy(): void;
}

export const DEFAULT_COLLAB_ROOM = "anvilkit-default-room";
export const DEFAULT_COLLAB_PROVIDER: ManagedTransportProvider = "hocuspocus";

interface AttachedProvider {
	readonly provider: { destroy(): void };
	readonly detach: () => void;
}

interface AttachArgs {
	readonly doc: YDoc;
	readonly awareness: Awareness;
	readonly url: string;
	readonly room: string;
	readonly token: string;
	readonly webSocketPolyfill: unknown;
	readonly emit: (status: ConnectionStatus) => void;
}

/**
 * Create a managed transport. Returns synchronously; the provider attaches
 * lazily when the adapter invokes `connectionSource(emit)`.
 */
export function createManagedTransport(
	options: CreateManagedTransportOptions,
): ManagedTransport {
	const doc = new YDoc();
	const ownsAwareness = options.awareness === undefined;
	const awareness = options.awareness ?? new Awareness(doc);
	const providerKind = options.provider ?? DEFAULT_COLLAB_PROVIDER;
	const room = options.room ?? DEFAULT_COLLAB_ROOM;
	const token = options.token ?? "";
	const url = options.websocketUrl;
	const reportError = createErrorReporter(options.onConnectionError);

	let disposed = false;
	let providerInstance: { destroy(): void } | undefined;
	let detachProviderEvents: (() => void) | undefined;

	// In-memory mode (no relay URL): single tab, no provider, and crucially NO
	// `connectionSource`. The adapter auto-flips `connecting`→`synced` on first
	// subscribe — matching the demo's in-memory transport. We must NOT emit
	// `synced` synchronously from a source here: `createConnectionStatus`
	// invokes `connectionSource(emit)` during adapter construction, and a
	// synchronous `synced` runs the adapter's `onSynced` before its snapshot
	// module exists (a temporal-dead-zone crash at `<Studio>` mount).
	const connectionSource: ConnectionSource | undefined = url
		? (emit) => {
				// Immediate optimistic state; the provider flips it on first sync.
				emit({ kind: "connecting" });

				// Validate synchronously. NEVER throw from here — a throw inside
				// the adapter's synchronous factory body would crash `<Studio>`.
				const urlError = validateWebsocketUrl(url);
				if (urlError) {
					emit({ kind: "error", message: urlError, recoverable: false });
					reportError(new Error(urlError));
					return () => undefined;
				}

				// Per-subscription teardown flag. If the adapter is torn down
				// before the provider's dynamic import resolves, a provider built
				// afterwards has no subscriber and must be destroyed immediately,
				// not parked on `providerInstance` awaiting a separate destroy().
				let tornDown = false;

				void (async () => {
					try {
						const attached = await attachProvider(providerKind, {
							doc,
							awareness,
							url,
							room,
							token,
							webSocketPolyfill: options.WebSocketPolyfill,
							emit,
						});
						if (disposed || tornDown) {
							// destroy() OR the source teardown ran before the
							// dynamic import resolved (StrictMode / fast unmount /
							// adapter torn down independently). Never keep a live
							// socket with no remaining subscriber.
							attached.detach();
							attached.provider.destroy();
							return;
						}
						providerInstance = attached.provider;
						detachProviderEvents = attached.detach;
					} catch (err) {
						if (disposed || tornDown) return;
						const pkg =
							providerKind === "hocuspocus"
								? "@hocuspocus/provider"
								: "y-websocket";
						emit({
							kind: "error",
							message: `Collab provider '${providerKind}' is not installed. Run \`npm i ${pkg}\`.`,
							recoverable: false,
						});
						reportError(err);
					}
				})();

				// Adapter-destroy path: stop listening and mark torn down so a
				// provider still mid-import is reaped (above) instead of parked.
				// An already-attached provider's socket + doc + awareness are
				// owned by destroy() below (mirrors the demo bundle).
				return () => {
					tornDown = true;
					detachProviderEvents?.();
					detachProviderEvents = undefined;
				};
			}
		: undefined;

	return {
		doc,
		awareness,
		connectionSource,
		destroy() {
			disposed = true;
			detachProviderEvents?.();
			detachProviderEvents = undefined;
			providerInstance?.destroy();
			providerInstance = undefined;
			// Only dispose awareness we created; a BYO awareness is the host's.
			if (ownsAwareness) awareness.destroy();
			doc.destroy();
		},
	};
}

function attachProvider(
	kind: ManagedTransportProvider,
	args: AttachArgs,
): Promise<AttachedProvider> {
	return kind === "hocuspocus"
		? attachHocuspocusProvider(args)
		: attachYWebsocketProvider(args);
}

/**
 * y-websocket backend. Promoted verbatim from the demo's
 * `createCollabRelayTransport`: tracks offline `queuedEdits`, maps
 * `status`/`sync`/`connection-error` into `ConnectionStatus`.
 */
async function attachYWebsocketProvider(
	args: AttachArgs,
): Promise<AttachedProvider> {
	const { WebsocketProvider } = await import("y-websocket");
	const { doc, awareness, url, room, emit } = args;
	const provider = new WebsocketProvider(url, room, doc, {
		awareness,
		connect: true,
		...(args.webSocketPolyfill
			? { WebSocketPolyfill: args.webSocketPolyfill as never }
			: {}),
	});

	let queuedEdits = 0;
	const handleDocUpdate = (_update: Uint8Array, origin: unknown) => {
		if (origin && typeof origin === "object" && "id" in origin) {
			if (provider.wsconnected === false) queuedEdits += 1;
			else queuedEdits = 0;
		}
	};
	doc.on("update", handleDocUpdate);

	const handleStatus = (event: { status: string }) => {
		emit(mapProviderStatus(event.status, queuedEdits));
	};
	const handleSync = (synced: boolean) => {
		if (synced) {
			queuedEdits = 0;
			emit({ kind: "synced", since: new Date().toISOString() });
		}
	};
	const handleConnectionError = (event: Event) => {
		emit({
			kind: "error",
			message:
				event instanceof CloseEvent
					? `WebSocket closed (${event.code})`
					: "WebSocket error",
			recoverable: true,
		});
	};
	provider.on("status", handleStatus);
	provider.on("sync", handleSync);
	provider.on("connection-error", handleConnectionError);

	return {
		provider,
		detach() {
			provider.off("status", handleStatus);
			provider.off("sync", handleSync);
			provider.off("connection-error", handleConnectionError);
			doc.off("update", handleDocUpdate);
		},
	};
}

/**
 * Hocuspocus backend. Promoted verbatim from the demo's
 * `createCollabHocuspocusTransport`, including the eager-attach snapshot:
 * the provider connects on construction, so its first `status`/`synced`
 * one-shots can fire before these listeners attach on a fast localhost relay.
 * Emitting the CURRENT state synchronously avoids the indicator sticking on
 * `connecting`. The `websocketProvider?.status` branch (absent from the docs
 * copy) is load-bearing — keep it.
 */
async function attachHocuspocusProvider(
	args: AttachArgs,
): Promise<AttachedProvider> {
	const { HocuspocusProvider } = await import("@hocuspocus/provider");
	const { doc, awareness, url, room, token, emit } = args;
	const provider = new HocuspocusProvider({
		url,
		name: room,
		document: doc,
		// Share the adapter's awareness instance so remote cursors flow.
		awareness,
		token,
		...(args.webSocketPolyfill
			? { WebSocketPolyfill: args.webSocketPolyfill as never }
			: {}),
	});

	// HocuspocusProvider's event payloads are loosely typed, so we narrow
	// each handler's argument shape inline.
	const handleStatus = ({ status }: { status: string }) => {
		emit(mapHocuspocusStatus(status));
	};
	const handleSynced = () => {
		emit({ kind: "synced", since: new Date().toISOString() });
	};
	const handleDisconnect = () => {
		emit({ kind: "offline", since: new Date().toISOString(), queuedEdits: 0 });
	};
	const handleAuthFailed = ({ reason }: { reason: string }) => {
		emit({
			kind: "error",
			message: `Authentication failed: ${reason}`,
			recoverable: false,
		});
	};
	provider.on("status", handleStatus);
	provider.on("synced", handleSynced);
	provider.on("disconnect", handleDisconnect);
	provider.on("authenticationFailed", handleAuthFailed);
	// Emit the CURRENT state synchronously on attach so we don't depend on
	// catching the provider's already-fired one-shot connect/sync events.
	if (provider.isSynced) {
		emit({ kind: "synced", since: new Date().toISOString() });
	} else if (
		provider.configuration.websocketProvider?.status === "disconnected"
	) {
		emit({ kind: "offline", since: new Date().toISOString(), queuedEdits: 0 });
	} else {
		emit({ kind: "connecting" });
	}

	return {
		provider,
		detach() {
			provider.off("status", handleStatus);
			provider.off("synced", handleSynced);
			provider.off("disconnect", handleDisconnect);
			provider.off("authenticationFailed", handleAuthFailed);
		},
	};
}

/**
 * @internal Exported for unit tests. Maps a Hocuspocus `WebSocketStatus`
 * string into the adapter's `ConnectionStatus`. Promoted verbatim.
 */
export function mapHocuspocusStatus(status: string): ConnectionStatus {
	// WebSocketStatus enum values are the string literals compared here, so
	// we avoid importing the enum at runtime.
	switch (status) {
		case "connected":
			return { kind: "synced", since: new Date().toISOString() };
		case "connecting":
			return { kind: "connecting" };
		case "disconnected":
			return {
				kind: "offline",
				since: new Date().toISOString(),
				queuedEdits: 0,
			};
		default:
			return { kind: "reconnecting", attempt: 1, backoffMs: 250 };
	}
}

/**
 * @internal Exported for unit tests. Maps a y-websocket `status` string into
 * the adapter's `ConnectionStatus`. Promoted verbatim.
 */
export function mapProviderStatus(
	status: string,
	queuedEdits: number,
): ConnectionStatus {
	switch (status) {
		case "connected":
			return { kind: "synced", since: new Date().toISOString() };
		case "connecting":
			return { kind: "connecting" };
		case "disconnected":
			return { kind: "offline", since: new Date().toISOString(), queuedEdits };
		default:
			return { kind: "reconnecting", attempt: 1, backoffMs: 250 };
	}
}

/** Returns an error message if the URL is unusable as a WebSocket endpoint, else `undefined`. */
function validateWebsocketUrl(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `Invalid websocketUrl: ${JSON.stringify(url)} is not a valid URL.`;
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		return `Invalid websocketUrl protocol "${parsed.protocol}". Use ws:// or wss://.`;
	}
	return undefined;
}

/** Default `onConnectionError` logs once; a host-supplied handler fires every time. */
function createErrorReporter(
	custom?: (err: unknown) => void,
): (err: unknown) => void {
	if (custom) return custom;
	let warned = false;
	return (err) => {
		if (warned) return;
		warned = true;
		console.error("[anvilkit/collab] transport error:", err);
	};
}
