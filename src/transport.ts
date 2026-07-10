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
 * demo's hand-written transport (`apps/studio/lib/collab-transport.ts`) — they
 * are already battle-tested; this module moves them, it does not rewrite them.
 */

import { Awareness } from "y-protocols/awareness";
import { Doc as YDoc } from "yjs";

import type {
	CollabLogger,
	ConnectionSource,
	ConnectionStatus,
} from "./types/types.js";
import {
	createReconnectTracker,
	type ReconnectBackoffOptions,
	type ReconnectTracker,
} from "./utils/reconnect-tracker.js";

/**
 * Default {@link CreateManagedTransportOptions.connectTimeoutMs}: how long a
 * transport may stay in `connecting`/`reconnecting` without ever reaching
 * `synced` before the adapter surfaces an explicit `reason: "timeout"` error
 * (§4.2.1). 30s mirrors y-websocket's own `messageReconnectTimeout` default.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

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
	/**
	 * Optional logging hook. When no `onConnectionError` is supplied, the
	 * default error reporter routes through this logger (level `"error"`)
	 * instead of `console.error`; when omitted, the console fallback is
	 * preserved. See {@link CollabLogger}.
	 */
	readonly logger?: CollabLogger;
	/**
	 * §4.2.1 — connection timeout. If the transport stays in
	 * `connecting`/`reconnecting` for this many ms without ever reaching
	 * `synced`, the adapter surfaces an explicit
	 * `{ kind: "error", reason: "timeout", recoverable: true }` so a host
	 * can distinguish "still trying, taking too long" from a hard transport
	 * failure. The timeout is armed once when the connecting phase begins and
	 * cleared on the first `synced`; it fires at most once per outage (a
	 * later `synced` re-arms it for the next outage). Set `<= 0` or
	 * `Infinity` to disable. Default {@link DEFAULT_CONNECT_TIMEOUT_MS}
	 * (`30000`).
	 */
	readonly connectTimeoutMs?: number;
	/**
	 * §4.2.1 — tunables for the jittered exponential reconnect backoff the
	 * transport reports on each `reconnecting` status. The attempt counter
	 * increments per disconnect→reconnect cycle and resets on `synced`; the
	 * backoff grows `baseMs * factor^(attempt-1)` (clamped to `maxMs`) with
	 * equal-jitter randomization. Inject `rng` to make the backoff
	 * deterministic in tests. See {@link ReconnectBackoffOptions}.
	 */
	readonly reconnectBackoff?: ReconnectBackoffOptions;
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
	/** §4.2.1 — reconnect backoff tunables threaded into the provider tracker. */
	readonly reconnectBackoff?: ReconnectBackoffOptions;
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
	const reportError = createErrorReporter(
		options.onConnectionError,
		options.logger,
	);
	const connectTimeoutMs =
		options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

	let disposed = false;
	let providerInstance: { destroy(): void } | undefined;
	let detachProviderEvents: (() => void) | undefined;
	// §4.2.1 — armed inside `connectionSource`; hoisted so `destroy()` can
	// clear it even if the adapter never invokes the source teardown.
	let cancelConnectTimeout: (() => void) | undefined;

	// In-memory mode (no relay URL): single tab, no provider, and crucially NO
	// `connectionSource`. The adapter auto-flips `connecting`→`synced` on first
	// subscribe — matching the demo's in-memory transport. We must NOT emit
	// `synced` synchronously from a source here: `createConnectionStatus`
	// invokes `connectionSource(emit)` during adapter construction, and a
	// synchronous `synced` runs the adapter's `onSynced` before its snapshot
	// module exists (a temporal-dead-zone crash at `<Studio>` mount).
	const connectionSource: ConnectionSource | undefined = url
		? (emit) => {
				// §4.2.1 connection-timeout guard. `wrappedEmit` watches the
				// status stream the provider drives and arms a one-shot timer the
				// first time we enter a `connecting`/`reconnecting` phase. If the
				// transport never reaches `synced` before `connectTimeoutMs`, it
				// surfaces an explicit `reason: "timeout"` error. The timer is
				// cleared on the first `synced` (success) and on any
				// non-recoverable error (terminal); a recoverable transport blip
				// leaves it running so a long outage still escalates. It fires at
				// most once per outage — a later `synced` re-arms it.
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				let timedOut = false;
				const clearConnectTimeout = (): void => {
					if (timeoutHandle !== undefined) {
						clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
				};
				const armConnectTimeout = (): void => {
					if (
						timeoutHandle !== undefined ||
						timedOut ||
						!Number.isFinite(connectTimeoutMs) ||
						connectTimeoutMs <= 0
					) {
						return;
					}
					timeoutHandle = setTimeout(() => {
						timeoutHandle = undefined;
						timedOut = true;
						emit({
							kind: "error",
							reason: "timeout",
							message: `Collab connection timed out after ${connectTimeoutMs}ms without syncing.`,
							recoverable: true,
						});
					}, connectTimeoutMs);
				};
				cancelConnectTimeout = clearConnectTimeout;
				const wrappedEmit = (status: ConnectionStatus): void => {
					if (status.kind === "synced") {
						timedOut = false;
						clearConnectTimeout();
					} else if (
						status.kind === "connecting" ||
						status.kind === "reconnecting"
					) {
						armConnectTimeout();
					} else if (status.kind === "error" && !status.recoverable) {
						// Terminal failure (bad URL, missing lib, auth) — no retry
						// loop to time out, so stop the clock.
						clearConnectTimeout();
					}
					emit(status);
				};

				// Immediate optimistic state; the provider flips it on first sync.
				// Routed through `wrappedEmit` so it arms the connection timeout.
				wrappedEmit({ kind: "connecting" });

				// Validate synchronously. NEVER throw from here — a throw inside
				// the adapter's synchronous factory body would crash `<Studio>`.
				const urlError = validateWebsocketUrl(url);
				if (urlError) {
					wrappedEmit({
						kind: "error",
						reason: "transport",
						message: urlError,
						recoverable: false,
					});
					reportError(new Error(urlError));
					return () => {
						clearConnectTimeout();
						cancelConnectTimeout = undefined;
					};
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
							emit: wrappedEmit,
							reconnectBackoff: options.reconnectBackoff,
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
						wrappedEmit({
							kind: "error",
							reason: "transport",
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
					clearConnectTimeout();
					cancelConnectTimeout = undefined;
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
			cancelConnectTimeout?.();
			cancelConnectTimeout = undefined;
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

	// §4.2.1 — incremental reconnect attempt/backoff. The stateful mapper owns
	// the dropped→reconnect transition so a `connecting` that follows a drop is
	// reported as `reconnecting` with a growing, jittered backoff instead of a
	// static `{ attempt: 1, backoffMs: 250 }`.
	const statusMapper = createProviderStatusMapper(
		(status) => mapProviderStatus(status, queuedEdits),
		createReconnectTracker(args.reconnectBackoff),
	);
	const handleStatus = (event: { status: string }) => {
		emit(statusMapper.map(event.status));
	};
	const handleSync = (synced: boolean) => {
		if (synced) {
			queuedEdits = 0;
			statusMapper.noteSynced();
			emit({ kind: "synced", since: new Date().toISOString() });
		}
	};
	const handleConnectionError = (event: Event) => {
		// y-websocket has no dedicated auth-failed event (a rejected upgrade
		// surfaces as a socket close/error), so every fault here is a
		// transport-level error — tagged explicitly to keep the discriminator
		// consistent with the Hocuspocus mapping above. Recoverable: the
		// provider auto-reconnects, so mark the cycle dropped — the next
		// `connecting` status then counts as a reconnect attempt.
		statusMapper.noteDropped();
		emit({
			kind: "error",
			reason: "transport",
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

	// §4.2.1 — incremental reconnect attempt/backoff (see y-websocket attach).
	const statusMapper = createProviderStatusMapper(
		mapHocuspocusStatus,
		createReconnectTracker(args.reconnectBackoff),
	);
	// HocuspocusProvider's event payloads are loosely typed, so we narrow
	// each handler's argument shape inline.
	const handleStatus = ({ status }: { status: string }) => {
		emit(statusMapper.map(status));
	};
	const handleSynced = () => {
		statusMapper.noteSynced();
		emit({ kind: "synced", since: new Date().toISOString() });
	};
	const handleDisconnect = () => {
		statusMapper.noteDropped();
		emit({ kind: "offline", since: new Date().toISOString(), queuedEdits: 0 });
	};
	const handleAuthFailed = ({ reason }: { reason: string }) => {
		// First-class auth/permission failure. Tagged `reason: "auth"` so a
		// host can distinguish it from a generic transport drop and prompt
		// for fresh credentials instead of a blind retry. Non-recoverable:
		// retrying the same rejected token reproduces the failure.
		emit({
			kind: "error",
			reason: "auth",
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
		statusMapper.noteSynced();
		emit({ kind: "synced", since: new Date().toISOString() });
	} else if (
		provider.configuration.websocketProvider?.status === "disconnected"
	) {
		statusMapper.noteDropped();
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
 *
 * The `default`/`reconnecting` branch returns a static
 * `{ attempt: 1, backoffMs: 250 }` as a back-compat fallback for direct
 * callers; the live transport path wraps this in {@link createProviderStatusMapper}
 * so reconnect attempts/backoff are incremental and jittered (§4.2.1).
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
 * the adapter's `ConnectionStatus`. Promoted verbatim. See
 * {@link mapHocuspocusStatus} for the reconnect-fallback note.
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

/**
 * §4.2.1 — stateful wrapper around a base provider-status mapper that owns
 * reconnection semantics. It tracks whether the connection has dropped so a
 * `connecting` status that *follows* a drop is reported as `reconnecting`
 * (with the tracker's incrementing attempt + jittered backoff) rather than a
 * fresh `connecting`. The attempt counter resets on every `synced`. One
 * instance lives per provider attach.
 */
export interface ProviderStatusMapper {
	/** Map a raw provider status string, applying reconnect bookkeeping. */
	map(status: string): ConnectionStatus;
	/**
	 * Note a confirmed sync arriving through a side channel (a provider's
	 * dedicated `sync`/`synced` event, or the eager-attach snapshot) so the
	 * reconnect attempt counter resets even though no `"connected"` status
	 * string passed through {@link ProviderStatusMapper.map}.
	 */
	noteSynced(): void;
	/**
	 * Note a drop arriving through a side channel (a `connection-error` /
	 * `disconnect` event) so the next `connecting` status counts as a
	 * reconnect attempt.
	 */
	noteDropped(): void;
}

/**
 * @internal Exported for unit tests.
 */
export function createProviderStatusMapper(
	base: (status: string) => ConnectionStatus,
	tracker: ReconnectTracker,
): ProviderStatusMapper {
	let dropped = false;

	function reconnecting(): ConnectionStatus {
		const { attempt, backoffMs } = tracker.recordReconnect();
		return { kind: "reconnecting", attempt, backoffMs };
	}

	return {
		map(status: string): ConnectionStatus {
			switch (status) {
				case "connected":
					dropped = false;
					tracker.reset();
					return base(status);
				case "connecting":
					// A `connecting` that follows a drop is a reconnect attempt.
					return dropped ? reconnecting() : base(status);
				case "disconnected":
					dropped = true;
					return base(status);
				default:
					// Unknown / provider-specific transitional state — treat as a
					// reconnect cycle.
					dropped = true;
					return reconnecting();
			}
		},
		noteSynced(): void {
			dropped = false;
			tracker.reset();
		},
		noteDropped(): void {
			dropped = true;
		},
	};
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
	logger?: CollabLogger,
): (err: unknown) => void {
	if (custom) return custom;
	let warned = false;
	return (err) => {
		if (warned) return;
		warned = true;
		// Route through the host logger when provided; otherwise preserve the
		// historical `console.error` fallback so existing callers are unchanged.
		if (logger) {
			logger("error", "[anvilkit/collab] transport error:", err);
		} else {
			console.error("[anvilkit/collab] transport error:", err);
		}
	};
}
