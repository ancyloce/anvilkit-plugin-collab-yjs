import type {
	PageIR,
	PageIRNode,
	StudioPlugin,
	StudioPluginContext,
	StudioPluginRegistration,
} from "@anvilkit/core/types";
import { irToPuckData, puckDataToIR } from "@anvilkit/ir";
import type { PeerInfo } from "@anvilkit/plugin-version-history";
import { Users } from "lucide-react";
import { createElement } from "react";

import config from "../meta/config.json";
import packageJson from "../package.json";
import type {
	CollabPolicy,
	CreateCollabPluginOptions,
	PolicyViolation,
	RemoteChange,
	ValidationFailure,
} from "./types/types.js";
import { DebouncedAdapterDestroyedError } from "./utils/debounced-adapter.js";
import {
	createInboundScheduler,
	type InboundScheduler,
} from "./utils/inbound-scheduler.js";
import {
	createLocationIndex,
	type LocationIndex,
	projectChangedNodes,
} from "./utils/incremental-projection.js";
import { nowMs, type TimingKind } from "./utils/metrics.js";
import {
	type PuckContentItem,
	type PuckData,
	type ReplaceAction,
	ROOT_DROPPABLE_ID,
} from "./utils/puck-shapes.js";
import {
	createRemoteDispatchGuard,
	type RemoteDispatchGuard,
} from "./utils/remote-guard.js";

/**
 * Internal telemetry surface optionally exposed by `createYjsAdapter`
 * (P1/H1). Feature-detected — a non-Yjs `SnapshotAdapter` simply omits
 * these and the plugin records nothing.
 */
type AdapterTelemetry = {
	readonly recordTiming?: (kind: TimingKind, ms: number) => void;
	readonly incInboundCoalesced?: (n: number) => void;
};

/**
 * Above this many `replace` actions a single `setData` is cheaper than
 * dispatching one action per node (P1 replace batching). The crossover
 * is informed by `bench/plugin-collab-yjs.bench.ts`; 50 is a
 * conservative default well below the per-keystroke replace counts
 * (1–2) but under the bulk-edit / paste counts where `setData` wins.
 */
const REPLACE_BATCH_THRESHOLD = 50;

const ROOM_KEY = "default";

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

/**
 * Dirty-field shield state. `pending` is the latest local intent IR
 * (set on every outbound `onDataChange`, including the keystroke still
 * inside the debounce window). `lastDispatched` is the last *converged*
 * remote/hydrated IR Puck was reconciled toward — the baseline used to
 * decide which props the local user actually edited (and therefore must
 * not be reverted by an incoming remote merge that still carries the
 * pre-edit saved value).
 */
interface LocalShadow {
	pending?: PageIR;
	pendingAt: number;
	lastDispatched?: PageIR;
	// §P2 — memoised `indexNodesById(lastDispatched)`. The converged
	// baseline only changes when *we* dispatch, so its node index can
	// be reused across every interleaving remote flush instead of
	// re-walking the whole tree each time the shield runs. Keyed on the
	// baseline IR reference so a new baseline transparently rebuilds it.
	baselineIndex?: {
		readonly ir: PageIR;
		readonly nodes: Map<string, PageIRNode>;
	};
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

// `version` is derived from package.json so a Changesets bump can never drift
// the runtime metadata; the metadata-drift guard in
// `src/__tests__/plugin.metadata-drift.test.ts` (M1) catches regressions.
const META = {
	...config,
	version: packageJson.version,
	icon: createElement(Users),
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
	let scheduler: InboundScheduler | undefined;
	// C3 — initial snapshot hydration must run when `getPuckApi()` is
	// safe to call. In a real `<Studio>` mount that is the post-mount
	// `onReady` hook, not `onInit` (the binder has not captured the
	// API yet). Headless/test contexts expose a working `getPuckApi()`
	// during `onInit`, so we still hydrate there for deterministic,
	// synchronous post-init state. This flag makes the two paths
	// mutually exclusive so hydration never runs twice.
	let hydrationDone = false;
	// C3 — gate the live scheduler flush on Puck-API readiness. A real
	// relay (e.g. Hocuspocus with server-side persistence) pushes its
	// stored snapshot to the client the instant the WebSocket syncs,
	// which can land AFTER `onInit` wires `subscribe` but BEFORE Puck's
	// effect-time binder has captured `getPuckApi()`. Flushing then would
	// call an unbound `getPuckApi()`, throw `PUCK_API_UNBOUND`, and
	// surface as "remote update dispatch failed". The hydration path
	// already guards this (probe + defer to `onReady`); this flag extends
	// the same guard to the scheduler flush.
	let puckReady = false;
	const pendingRemoteData = new Map<string, PendingRemoteEntry>();
	const localShadow: LocalShadow = { pendingAt: 0 };
	const ephemeralPeer = options.localPeer ?? createEphemeralPeer();
	const usedEphemeralPeer = options.localPeer === undefined;
	// H2 — one re-entrant guard per plugin instance, threaded into
	// dispatchRemoteIR and consulted by onDataChange.
	const remoteGuard = createRemoteDispatchGuard();
	// §P1 — one id→owner index per plugin instance, carried across
	// dispatches so steady-state remote edits skip the full-document
	// re-index the old per-`Data`-identity WeakMap forced every flush.
	const locationIndex = createLocationIndex();
	const telemetry = options.adapter as AdapterTelemetry;

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
						// H1 — inbound coalescing. The subscribe callback no
						// longer dispatches synchronously inside the Yjs
						// call stack; it enqueues latest-wins and the
						// scheduler flushes ≤ once per animation frame.
						scheduler = createInboundScheduler({
							flush: (
								_room,
								latestIR,
								latestPeer,
								queueDelayMs,
								latestChanged,
							) => {
								// Hold inbound dispatch until Puck's API is bound.
								// A pre-ready flush would crash in `getPuckApi()`;
								// the scheduler is latest-wins, so nothing is lost —
								// `onReady`'s `hydrateLatestSnapshot` paints the
								// current doc state, then `flushNow()` drains any
								// update buffered across the readiness flip.
								if (!puckReady) return;
								telemetry.recordTiming?.("inboundQueueDelay", queueDelayMs);
								dispatchRemoteIR(
									initCtx,
									latestIR,
									pendingRemoteData,
									localShadow,
									options,
									ephemeralPeer,
									remoteGuard,
									locationIndex,
									telemetry,
									latestPeer,
									latestChanged,
								);
							},
							onCoalesced: (n) => telemetry.incInboundCoalesced?.(n),
							scheduler: options.inboundScheduler,
							budgetMs: options.inboundBudgetMs,
						});
						unsubscribe = options.adapter.subscribe(
							(ir, peer, changed?: RemoteChange) => {
								scheduler?.enqueue(ROOM_KEY, ir, peer, changed);
							},
						);
						// Hydration deliberately bypasses the scheduler: it is a
						// one-shot initial paint. C3 — only hydrate here when
						// `getPuckApi()` is already callable (headless / test
						// contexts). In a real `<Studio>` mount the effect-time
						// binder has not run yet, so probing throws
						// PUCK_API_UNBOUND; we defer to the post-mount `onReady`
						// hook instead of failing the initial hydrate or logging
						// a dispatch error.
						let puckApiReady = false;
						try {
							initCtx.getPuckApi();
							puckApiReady = true;
						} catch {
							puckApiReady = false;
						}
						if (puckApiReady && !hydrationDone) {
							hydrationDone = true;
							await hydrateLatestSnapshot(
								initCtx,
								options,
								pendingRemoteData,
								localShadow,
								ephemeralPeer,
								remoteGuard,
								locationIndex,
								telemetry,
							);
						}
						// Headless / test contexts expose a bound `getPuckApi()`
						// during `onInit`, so the scheduler may flush immediately.
						// Real mounts keep `puckReady` false here and flip it in
						// `onReady` once the binder has captured the API.
						puckReady = puckApiReady;
					},
					async onReady(readyCtx) {
						// C3 — real-mount hydration path. Runs once the Puck-API
						// binder has captured `getPuckApi()`. Skipped if `onInit`
						// already hydrated (headless / test) so hydration is
						// exactly-once.
						if (hydrationDone) return;
						if (typeof options.adapter.subscribe !== "function") {
							return;
						}
						hydrationDone = true;
						await hydrateLatestSnapshot(
							readyCtx,
							options,
							pendingRemoteData,
							localShadow,
							ephemeralPeer,
							remoteGuard,
							locationIndex,
							telemetry,
						);
						// Puck's API is now bound. Allow scheduler flushes, then
						// drain any inbound update buffered during the mount window
						// (an empty/no-op buffer is a cheap rAF-cancel + return).
						puckReady = true;
						scheduler?.flushNow();
					},
					onDataChange(changeCtx, data) {
						// H2 — suppress every onDataChange emitted during
						// (and within one frame after) a remote dispatch,
						// including per-`replace` intermediate states that
						// the old final-key match let leak into save().
						// `noteSuppressed()` tells the dispatch region a
						// synchronous echo was handled here, so it can skip
						// the O(document) exact-data fallback entirely.
						if (remoteGuard.withinGraceWindow(nowMs())) {
							remoteGuard.noteSuppressed();
							return;
						}
						// M3 — only pay the O(document) stable stringify
						// echo check when an echo could actually be
						// pending. The common local-edit path (no remote
						// in flight, empty map) skips it entirely.
						if (
							pendingRemoteData.size > 0 &&
							consumePendingRemoteData(data, pendingRemoteData)
						) {
							return;
						}
						if (!options.puckConfig) return;
						const convStart = nowMs();
						const ir = puckDataToIR(data, options.puckConfig);
						telemetry.recordTiming?.("conversion", nowMs() - convStart);
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
							// Dirty-field shield: record the local user's latest
							// intent (including a keystroke still inside the
							// adapter's debounce window) so an interleaving
							// remote merge does not revert the focused field
							// back to its last *saved* value. Remote echoes are
							// already short-circuited above (H2 grace window /
							// pendingRemoteData), so this only captures genuine
							// local edits.
							localShadow.pending = ir;
							localShadow.pendingAt = nowMs();
							const result = options.adapter.save(ir, {});
							Promise.resolve(result).catch((error: unknown) => {
								// A pending debounced save rejecting with
								// `DebouncedAdapterDestroyedError` is expected
								// teardown noise: the adapter was destroyed (Studio
								// unmount / plugin remount) before the flush window
								// elapsed. It is not a persistence failure, so log
								// it at `debug` rather than `error`. Genuine save
								// failures stay at `error`.
								//
								// Pass the raw error through either way so core's
								// `normalizeLogError` captures name + message +
								// stack — pre-extracting `error.message` would drop
								// the name/stack and collapse an empty-message Error
								// to `{}` in the dev overlay (see the regression
								// tests in plugin.save-error.test.ts).
								if (error instanceof DebouncedAdapterDestroyedError) {
									changeCtx.log(
										"debug",
										"plugin-collab-yjs: outbound save skipped — adapter torn down before flush (benign unmount/remount).",
										{ error },
									);
								} else {
									changeCtx.log(
										"error",
										"plugin-collab-yjs: outbound save failed.",
										{ error },
									);
								}
								// `onSaveError` is a documented opt-in hook; teardown
								// is still surfaced through it (see the A3 lifecycle
								// test) so consumers that care can react.
								options.onSaveError?.(error);
							});
						} catch (error) {
							changeCtx.log(
								"error",
								"plugin-collab-yjs: outbound save threw synchronously.",
								{ error },
							);
							options.onSaveError?.(error);
						}
					},
					onDestroy() {
						if (scheduler) {
							scheduler.destroy();
							scheduler = undefined;
						}
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
	localShadow: LocalShadow,
	localPeer: PeerInfo,
	remoteGuard: RemoteDispatchGuard,
	locationIndex: LocationIndex,
	telemetry: AdapterTelemetry,
): Promise<void> {
	try {
		const snapshots = await Promise.resolve(options.adapter.list());
		const latest = snapshots.at(-1);
		if (!latest) return;
		const ir = await Promise.resolve(options.adapter.load(latest.id));
		dispatchRemoteIR(
			ctx,
			ir,
			pendingRemoteData,
			localShadow,
			options,
			localPeer,
			remoteGuard,
			locationIndex,
			telemetry,
		);
	} catch (error) {
		ctx.log("warn", "plugin-collab-yjs: initial hydrate failed.", {
			error,
		});
	}
}

function dispatchRemoteIR(
	ctx: StudioPluginContext,
	ir: PageIR,
	pendingRemoteData: Map<string, PendingRemoteEntry>,
	localShadow: LocalShadow,
	options: CreateCollabPluginOptions,
	localPeer: PeerInfo,
	remoteGuard: RemoteDispatchGuard,
	locationIndex: LocationIndex,
	telemetry: AdapterTelemetry,
	peer?: PeerInfo,
	changed?: RemoteChange,
): void {
	const validated = runValidation(ctx, ir, options);
	if (validated === null) return;
	const checkedPeer = peer ?? localPeer;
	// Stage 3 (§3.4) — a non-structural remote edit can only newly
	// violate inbound policy on the nodes it actually touched; every
	// other node was already validated on a prior flush / hydration,
	// and local edits are policy-checked on the OUTBOUND path. So
	// scope the inbound `canEdit` walk to the changed ids. Structural
	// updates, hydration, and legacy adapters (`changed === undefined`)
	// keep the full-tree check.
	//
	// P1 — a `relink` (topology change: reorder / insert / delete) is
	// reported `structural: false` so the live-IR cache stays
	// incremental, but the Puck-side dispatch must NOT scope: a moved
	// id at a new slot is exactly what the scoped `replace` planner
	// cannot prove. Treat relink like structural here so the proven
	// full `irToPuckData` + `setData` path runs — byte-identical to the
	// pre-P1 behaviour for topology changes.
	const changedIds =
		changed !== undefined && !changed.structural && changed.relink === undefined
			? changed.ids
			: undefined;
	const violation = enforcePolicy(
		validated,
		checkedPeer,
		options.policy,
		"inbound",
		changedIds,
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
	// Dirty-field shield: re-apply the local user's not-yet-converged
	// edits on top of the merged remote IR so a `replace`/`setData`
	// never reverts a focused field to its last *saved* value (the
	// "Save changes!" ↔ "Save changes" flicker / caret jump). Computed
	// against the PREVIOUS converged baseline, so remote edits to props
	// the local user did not touch still pass through. `validated`
	// becomes the new baseline only AFTER the shield reads the old one.
	// Stage 3 (§3.4) — when the changed ids are known (non-structural
	// remote edit) the shield only needs to consider nodes the remote
	// touched OR nodes the local user has dirtied; every other node is
	// identical in remote/baseline/pending so the per-prop triple
	// stringify is wasted. `applyLocalShield` derives the dirty set
	// from its existing indexes and unions it with `changedIds`.
	// `undefined` (structural / hydration / legacy) keeps the full
	// recursive shield exactly as before.
	const shielded = applyLocalShield(
		validated,
		localShadow,
		nowMs(),
		changedIds,
	);
	localShadow.lastDispatched = validated;
	// Reading current data via `ctx.getData()` instead of
	// `getPuckApi().appState` keeps this path off Puck's API when
	// the plugin context is configured without a live `<Puck>`
	// mount (tests, headless validation). Read BEFORE conversion so
	// the Stage-2 incremental projection can reuse it.
	let currentData: PuckData | undefined;
	try {
		currentData = ctx.getData() as PuckData;
	} catch {
		// `getData` shouldn't throw, but if a host implementation
		// does, fall through to the dispatch path rather than swallow
		// the remote update silently.
		currentData = undefined;
	}
	// Stage 2 (§3.2/§3.3) — when the adapter pinned the changed
	// ids and Puck's current data is available, rebuild ONLY the
	// owner item(s) of those ids instead of converting the whole
	// IR. `projectChangedNodes` returns null for any shape it
	// cannot prove equals `irToPuckData(shielded)` (zone-bearing
	// owners, root-prop/root-id edits, relocated ids), so the full
	// round-trip stays the correctness backstop. Untouched items
	// keep object identity → the planner skips them via `a === b`.
	const convStart = nowMs();
	const projected =
		changedIds !== undefined && currentData !== undefined
			? projectChangedNodes(currentData, shielded, changedIds, locationIndex)
			: null;
	// `projected` is structurally a Puck `Data` (it clones a prior
	// `irToPuckData` output and rebuilds owner items with the SAME
	// shape `irToPuckData` produces). Cast to the full-conversion
	// return type so the `setData` dispatch and planner see one type.
	const data = (projected ?? irToPuckData(shielded)) as ReturnType<
		typeof irToPuckData
	>;
	telemetry.recordTiming?.("conversion", nowMs() - convStart);
	// T2 — drive the no-op skip from the dispatch plan instead of a
	// second full-document `stableStringify(currentData)` compared
	// to `stableStringify(data)`. A non-null plan with zero actions
	// means the structure is stable and every touched node is
	// byte-identical to what Puck already holds — a true no-op
	// (server echo of our own write, or a CRDT merge that changed
	// nothing the host renders). (`actions === null` — structural /
	// no-current-data / root- or zone-shape change — is NOT a no-op
	// and still proceeds to dispatch, exactly as before.)
	const planResult = planReplaceActions(currentData, data, changedIds);
	if (planResult.actions !== null && planResult.actions.length === 0) return;
	// H2 — hold the guard active across the ENTIRE dispatch
	// region so every onDataChange Puck emits per `replace` is
	// classified as remote echo, not a local save.
	const token = remoteGuard.begin();
	const dispatchStart = nowMs();
	let dispatchFailed = false;
	try {
		// `planResult` (and its O(changed) `changedIds` narrowing)
		// was computed above so it could also drive the no-op skip.
		// Prefer atomic `replace` per changed item over the heavy
		// `setData`: `replace` only re-renders the replaced item;
		// siblings keep React identity, preserving a focused peer's
		// textarea caret when a remote peer edits a different node —
		// or a different prop of the same node. Falls through to
		// `setData` for structural changes (insert/remove/reorder,
		// zone topology) or when the replace count crosses the batch
		// threshold (P1 — one setData beats N dispatches).
		const api = ctx.getPuckApi();
		const replaceBatchThreshold =
			options.replaceBatchThreshold ?? REPLACE_BATCH_THRESHOLD;
		if (
			planResult.actions !== null &&
			planResult.actions.length <= replaceBatchThreshold
		) {
			for (const action of planResult.actions) api.dispatch(action);
		} else {
			// §P1 — the slow path replaces the whole tree, so
			// the carried index's structure assumptions no longer
			// hold; drop it so the next flush reseeds from fresh data.
			locationIndex.invalidate();
			api.dispatch({ type: "setData", data });
		}
	} catch (error) {
		dispatchFailed = true;
		ctx.log("error", "plugin-collab-yjs: remote update dispatch failed.", {
			error,
		});
	} finally {
		telemetry.recordTiming?.("dispatch", nowMs() - dispatchStart);
		remoteGuard.end(token);
		// I1/§4 — the exact-data `pendingRemoteData` fallback is now
		// LAZY. A synchronous host (Puck) fires its echo onChange(s)
		// inside `api.dispatch` while the guard is active; those are
		// suppressed there (no stringify) and reported via
		// `consumedSyncEcho()`. Only an async/pathological host that
		// emits onChange AFTER the dispatch returns needs the
		// exact-data match — so the O(document) `stableStringify` is
		// paid ONLY on that path, never on the synchronous hot path
		// (every flush previously stringified the whole tree here).
		// A failed dispatch produces no echo, so it registers
		// nothing (replaces the old speculative count + rollback).
		if (!dispatchFailed && !remoteGuard.consumedSyncEcho()) {
			const key = stableStringify(data);
			const now = nowMs();
			sweepPendingRemoteData(pendingRemoteData, now);
			const existing = pendingRemoteData.get(key);
			if (existing) {
				existing.count += 1;
				existing.addedAt = now;
			} else {
				pendingRemoteData.set(key, { count: 1, addedAt: now });
			}
		}
	}
}

function indexNodesById(ir: PageIR): Map<string, PageIRNode> {
	const out = new Map<string, PageIRNode>();
	walkNodes(ir.root, (node) => {
		out.set(node.id, node);
	});
	return out;
}

/**
 * Dirty-field shield. Returns `remote` with every prop the local user
 * has edited away from the previous converged baseline
 * (`shadow.lastDispatched`) — and which the merged remote IR does not
 * already carry — overwritten by the local (not-yet-saved) value.
 *
 * Three-way per prop, so it shields ONLY genuine local edits: a prop
 * the remote peer changed but the local user did not touch
 * (`pending === baseline`) passes through as the remote value and still
 * converges. A node absent from the baseline (local insert / structural
 * change) is left to the existing `setData` fallback. The pending
 * shadow is ignored once older than `PENDING_REMOTE_MAX_AGE_MS` so a
 * stuck buffer can never permanently mask a real remote change.
 */
function applyLocalShield(
	remote: PageIR,
	shadow: LocalShadow,
	now: number,
	changedIds?: ReadonlySet<string>,
): PageIR {
	const pending = shadow.pending;
	const baseline = shadow.lastDispatched;
	if (!pending || !baseline) return remote;
	if (now - shadow.pendingAt > PENDING_REMOTE_MAX_AGE_MS) return remote;
	const pendingNodes = indexNodesById(pending);
	// §P2 — reuse the cached baseline index when the converged
	// baseline IR is unchanged (the common case: it only advances on
	// our own dispatch, not on each interleaving remote flush).
	let baselineNodes: Map<string, PageIRNode>;
	if (shadow.baselineIndex?.ir === baseline) {
		baselineNodes = shadow.baselineIndex.nodes;
	} else {
		baselineNodes = indexNodesById(baseline);
		shadow.baselineIndex = { ir: baseline, nodes: baselineNodes };
	}
	// Stage 3 (§3.4) — when the changed ids are known, the shield only
	// needs to act on nodes the local user actually dirtied (pending
	// props differ from the converged baseline) unioned with the
	// remote-changed ids. Every other node has pending === baseline so
	// the inner `localVal !== baseVal` test can never fire — skipping
	// it just avoids the wasted per-prop triple stringify. `undefined`
	// (structural / hydration / legacy) keeps the full shield.
	let scope: Set<string> | undefined;
	if (changedIds !== undefined) {
		scope = new Set(changedIds);
		for (const [id, p] of pendingNodes) {
			const b = baselineNodes.get(id);
			if (
				b !== undefined &&
				stableStringify(p.props ?? {}) !== stableStringify(b.props ?? {})
			) {
				scope.add(id);
			}
		}
	}
	let mutated = false;
	const rewrite = (node: PageIRNode): PageIRNode => {
		const p = pendingNodes.get(node.id);
		const b = baselineNodes.get(node.id);
		let nextProps = node.props;
		if (p && b && (scope === undefined || scope.has(node.id))) {
			const pProps = p.props ?? {};
			const bProps = b.props ?? {};
			const rProps = node.props ?? {};
			for (const key of Object.keys(pProps)) {
				const localVal = stableStringify(pProps[key]);
				const baseVal = stableStringify(bProps[key]);
				const remoteVal = stableStringify(rProps[key]);
				// Local edited this prop (differs from converged baseline)
				// and the merged remote value is something else → keep the
				// local unsaved value so the focused field never reverts.
				if (localVal !== baseVal && localVal !== remoteVal) {
					if (nextProps === node.props) {
						nextProps = { ...(node.props ?? {}) };
					}
					(nextProps as Record<string, unknown>)[key] = pProps[key];
					mutated = true;
				}
			}
		}
		// §P2 — visit every child (structural traversal is unavoidable
		// to locate a shielded node) but allocate a replacement array
		// ONLY along the ancestor path of an actually-rewritten node.
		// Off-path subtrees keep identity and cost zero allocation,
		// turning the old per-node `.map` (O(document) garbage) into
		// O(changed + depth).
		let children = node.children;
		if (node.children) {
			let rebuilt: PageIRNode[] | undefined;
			let i = 0;
			for (const original of node.children) {
				const next = rewrite(original);
				if (next !== original && rebuilt === undefined) {
					rebuilt = node.children.slice(0, i);
				}
				if (rebuilt !== undefined) rebuilt.push(next);
				i += 1;
			}
			if (rebuilt !== undefined) children = rebuilt;
		}
		if (nextProps === node.props && children === node.children) return node;
		return {
			...node,
			props: nextProps,
			...(children ? { children } : {}),
		};
	};
	const root = rewrite(remote.root);
	return mutated ? { ...remote, root } : remote;
}

// `PuckData` / `PuckContentItem` / `ReplaceAction` / `ROOT_DROPPABLE_ID`
// are imported from `./puck-shapes.js` (A1) — the single source of
// truth shared with `incremental-projection.ts`.

/**
 * Plan a sequence of Puck `replace` actions that take `before` to
 * `after`, or return `null` if the structural shape changed enough
 * that `setData` is the safer fallback.
 *
 * The planner only emits replacements for items whose `props.id`
 * exists in both versions at the same `(zone, index)` slot. Inserts,
 * deletes, and reorders all fall through to `setData` so the host's
 * zone-index store stays consistent.
 */
interface PlanResult {
	readonly actions: readonly ReplaceAction[] | null;
	readonly fallbackReason?: string;
}

function planReplaceActions(
	before: PuckData | undefined,
	after: PuckData,
	changedIds?: ReadonlySet<string>,
): PlanResult {
	if (!before) return { actions: null, fallbackReason: "no-current-data" };
	// Compare just the root component's props rather than the raw
	// root object. Puck normalises `root: { props: {} }` and
	// `root: {}` differently, but for collab-dispatch purposes they
	// represent the same authoritative state — only the props
	// actually drive renderers.
	const beforeRootProps = extractRootProps(before.root);
	const afterRootProps = extractRootProps(after.root);
	if (!isShallowJsonEqual(beforeRootProps, afterRootProps)) {
		return { actions: null, fallbackReason: "root-changed" };
	}
	const beforeZoneKeys = new Set(Object.keys(before.zones ?? {}));
	const afterZoneKeys = new Set(Object.keys(after.zones ?? {}));
	if (
		beforeZoneKeys.size !== afterZoneKeys.size ||
		[...beforeZoneKeys].some((k) => !afterZoneKeys.has(k))
	) {
		return { actions: null, fallbackReason: "zone-keyset-changed" };
	}
	const actions: ReplaceAction[] = [];
	const contentDiff = diffZoneContent(
		ROOT_DROPPABLE_ID,
		before.content,
		after.content,
		changedIds,
	);
	if (contentDiff === null) {
		return { actions: null, fallbackReason: "content-structure-changed" };
	}
	actions.push(...contentDiff);
	for (const zoneKey of beforeZoneKeys) {
		const zoneDiff = diffZoneContent(
			zoneKey,
			before.zones?.[zoneKey],
			after.zones?.[zoneKey],
			changedIds,
		);
		if (zoneDiff === null) {
			return {
				actions: null,
				fallbackReason: `zone-${zoneKey}-structure-changed`,
			};
		}
		actions.push(...zoneDiff);
	}
	return { actions };
}

function diffZoneContent(
	zoneKey: string,
	before: ReadonlyArray<PuckContentItem> | undefined,
	after: ReadonlyArray<PuckContentItem> | undefined,
	changedIds?: ReadonlySet<string>,
): readonly ReplaceAction[] | null {
	const a = before ?? [];
	const b = after ?? [];
	if (a.length !== b.length) return null;
	const actions: ReplaceAction[] = [];
	for (let i = 0; i < a.length; i += 1) {
		const beforeItem = a[i];
		const afterItem = b[i];
		if (!beforeItem || !afterItem) return null;
		if (beforeItem.props.id !== afterItem.props.id) return null;
		if (beforeItem.type !== afterItem.type) return null;
		// Fast path: the adapter already told us which node ids a
		// non-structural remote edit touched. An item whose id is not
		// in that set is guaranteed unchanged, so skip the expensive
		// per-item stable-stringify equality. The structural guards
		// above still run for every index, so a mis-flagged reorder
		// (id-at-index shift) still falls back to `setData` — the set
		// only narrows *which props we compare*, never *whether we
		// trust the structure*.
		if (changedIds !== undefined && !changedIds.has(afterItem.props.id)) {
			continue;
		}
		if (isShallowJsonEqual(beforeItem, afterItem)) continue;
		actions.push({
			type: "replace",
			destinationZone: zoneKey,
			destinationIndex: i,
			data: afterItem,
		});
	}
	return actions;
}

function isShallowJsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return stableStringify(a) === stableStringify(b);
}

function extractRootProps(root: unknown): Record<string, unknown> {
	if (root === null || typeof root !== "object") return {};
	const obj = root as Record<string, unknown>;
	const props = obj.props;
	if (props && typeof props === "object" && !Array.isArray(props)) {
		return props as Record<string, unknown>;
	}
	return {};
}

function enforcePolicy(
	ir: PageIR,
	peer: PeerInfo,
	policy: CollabPolicy | undefined,
	direction: "inbound" | "outbound",
	scopeIds?: ReadonlySet<string>,
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
		// Stage 3 (§3.4) — when scoped (non-structural inbound), only
		// evaluate the nodes the remote edit touched. Traversal stays
		// O(nodes) but the (potentially user-supplied, arbitrarily
		// expensive) `policy.canEdit` runs only for changed ids.
		if (scopeIds !== undefined && !scopeIds.has(node.id)) return;
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
			error: failure.error,
		});
		options.onValidationFailure?.(failure);
	}
	return null;
}

function consumePendingRemoteData(
	data: unknown,
	pendingRemoteData: Map<string, PendingRemoteEntry>,
): boolean {
	// M3 — never stable-stringify the whole Puck tree when there is
	// nothing to match against (belt-and-suspenders with the size
	// guard at the onDataChange call site).
	if (pendingRemoteData.size === 0) return false;
	sweepPendingRemoteData(pendingRemoteData, nowMs());
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

export type { CreateCollabPluginOptions } from "./types/types.js";
