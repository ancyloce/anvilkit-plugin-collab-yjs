# @anvilkit/plugin-collab-yjs

> **Release candidate (`0.10.x`).** Ships under the `@next` npm dist-tag. Per-node CRDT merge (`useNativeTree`) is now the default. See `docs/policies/lts.md` for the GA timeline.

A first-party Anvilkit Studio plugin that proves the `SnapshotAdapter` v2 contract can host live CRDT state alongside Puck without forking Core or Puck. Built on [Yjs](https://github.com/yjs/yjs) and [`y-protocols/awareness`](https://github.com/yjs/y-protocols), it ships the data layer only — pair it with `@anvilkit/collab-ui` for the React presentation layer or compose your own UI on top of the public hooks.

## Scope / shared-type support

**This is a PageIR-only Yjs adapter, not a general-purpose Yjs binding.** It mirrors a single domain model — Puck's `PageIR` — into a flat-addressed `Y.Map` tree:

- one `Y.Map` per node (keyed `node:<id>`), holding the node's scalar fields;
- a per-parent `Y.Array<string>` `childIds` list for ordered structure;
- **JSON-encoded prop values** — each prop is stored as a `JSON.stringify`'d string inside the per-node `Y.Map`, so props are opaque to the CRDT and merge per-key (LWW), not character-by-character.

The **only** Yjs shared types it binds are therefore `Y.Map` and `Y.Array`. Native `Y.Text`, `Y.XmlElement`, `Y.XmlFragment`, and **subdocuments** are **out of scope** — there is no public binding that projects collaborative edits inside those types into the Puck editor. (In particular, rich-text props do not get character-level CRDT merge; a prop value is replaced wholesale on each save.)

This contract is exported and machine-checkable, so hosts can branch on it instead of reading prose:

```ts
import {
  SHARED_TYPE_SUPPORT,
  isManagedSharedType,
  getHostSharedRoot,
} from "@anvilkit/plugin-collab-yjs";

SHARED_TYPE_SUPPORT.model; // "page-ir"
SHARED_TYPE_SUPPORT.managed; // ["Y.Map", "Y.Array"]
SHARED_TYPE_SUPPORT.unsupported; // ["Y.Text", "Y.XmlElement", "Y.XmlFragment", "Y.Doc"]
SHARED_TYPE_SUPPORT.propEncoding; // "json-string"

isManagedSharedType("Y.Array"); // true
isManagedSharedType("Y.Text"); // false
```

**Escape hatch.** If you genuinely need a native shared type alongside the page (a `Y.Text` comment thread, a `Y.XmlFragment` field, a subdoc), `getHostSharedRoot(doc, namespace)` returns a top-level `Y.Map` on the **same** `Y.Doc`, namespaced under `` `${mapName}:host:${namespace}` `` so it can never collide with the two roots the adapter manages (the legacy blob root `mapName` and the native tree root `` `${mapName}:tree` ``). The adapter never reads or writes that map — its content does not appear in the projected `PageIR`, snapshots, undo, or conflict detection — but because it lives on the shared doc, Yjs still replicates it (and the opt-in persistence/transport still carries it). Interpreting and rendering it is entirely the host's responsibility.

```ts
import { getHostSharedRoot } from "@anvilkit/plugin-collab-yjs";
import * as Y from "yjs";

// Host-owned, adapter-ignored — safe to attach any native shared type.
const comments = getHostSharedRoot(doc, "comments");
const thread = new Y.Text();
comments.set("hero-1", thread);
```

## Installation

```bash
pnpm add @anvilkit/plugin-collab-yjs yjs y-protocols react react-dom @puckeditor/core
```

`yjs` and `y-protocols` are direct runtime dependencies. `react`, `react-dom`, and `@puckeditor/core` are **non-optional** peers even though this is the "data-only" layer: the package exports React hooks (e.g. `usePuckSelection`) and its plugin factory runs inside the React-based Studio shell, so React is genuinely required — it is not split into a React-free entry. For a transport, install `y-websocket` (demos) or wire your own provider (Hocuspocus, custom WebRTC, etc.).

## Quickstart

```ts
import {
  createCollabDataPlugin,
  createDebouncedAdapter,
  createYjsAdapter,
} from "@anvilkit/plugin-collab-yjs";
import { Doc as YDoc } from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new YDoc();
const provider = new WebsocketProvider(
  "ws://localhost:21234",
  "demo-room",
  doc,
);

const adapter = createYjsAdapter({
  doc,
  awareness: provider.awareness,
  peer: { id: "alice", displayName: "Alice", color: "#f43f5e" },
});

const debounced = createDebouncedAdapter(adapter, { ms: 150 });

registerPlugins([
  createCollabDataPlugin({
    adapter: debounced,
    puckConfig: myPuckConfig,
    localPeer: { id: "alice", displayName: "Alice", color: "#f43f5e" },
  }),
]);
```

For the full data + UI bundle in a single factory call, import `createCollabPlugin` from `@anvilkit/collab-ui` instead.

## Core features

- **Per-node CRDT merge by default** — `PageIR` is mirrored as a flat-addressed `Y.Map` tree, so concurrent edits to disjoint nodes both survive instead of overwriting each other under whole-document LWW.
- **Snapshot history** — every `save()` writes both the live encoding and a `snapshotMeta:<id>` + `snapshotPayload:<id>` pair, satisfying the `SnapshotAdapter` history contract regardless of which encoding is live.
- **Conflict diagnostics** — `onConflict(event)` fires when a remote update lands on top of a local in-flight edit within `staleAfterMs` (default 2000 ms).
- **Connection-state contract** — five-variant `ConnectionStatus` (`connecting`/`synced`/`offline`/`reconnecting`/`error`) lets hosts render a unified sync indicator without reading provider-specific fields.
- **Observability** — `metrics()` returns latency percentiles, awareness churn (5-minute sliding window), validation-failure counts, and main-thread hot-path timings for telemetry sinks.
- **Cross-tab persistence** — opt-in IndexedDB queue + same-origin `BroadcastChannel` relay. Survives brief disconnects and syncs two tabs of the same app without round-tripping through the transport.
- **Defense-in-depth presence security** — strict color allowlist, control-character stripping on display names, awareness rate-limiting, and a `validateRemoteIR` hook for hostile-peer rejection.
- **Force resync** — `adapter.forceResync()` discards unsaved local edits and re-emits the latest authoritative snapshot for the host's "discard and reload" affordance.
- **Opt-in local undo/redo** — supply the `undo` option to wrap a `Y.UndoManager` over the live `PageIR` tree. Only the local peer's edits are tracked, so `undo()` never rolls back a collaborator's work.

## API reference

### Factory functions

| Function                 | Signature                                                                       | Purpose                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createYjsAdapter`       | `(opts: CreateYjsAdapterOptions) => YjsSnapshotAdapter`                         | Builds the CRDT-backed `SnapshotAdapter` from a Yjs `Doc` and optional `Awareness`.                                                                                             |
| `createCollabDataPlugin` | `(opts: CreateCollabPluginOptions) => StudioPlugin`                             | Wraps the adapter into a Studio plugin (data sync only — no UI).                                                                                                                |
| `createDebouncedAdapter` | `(adapter, opts?: CreateDebouncedAdapterOptions) => SnapshotAdapterWithMetrics` | Coalesces rapid `save()` calls into a single transport write per debounce window (default 150 ms). Returns an adapter with a `destroy()` method that must be called on unmount. |
| `createCollabPlugin`     | _deprecated alias of `createCollabDataPlugin`_                                  | Retained for one minor release. Logs a one-shot `console.warn` on first call. Import `createCollabPlugin` from `@anvilkit/collab-ui` for the bundled UI factory.                |

### `CreateYjsAdapterOptions`

| Field                | Type                        | Default                | Purpose                                                                                                                                                                       |
| -------------------- | --------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc`                | `YDoc`                      | _required_             | Yjs document. Host-owned; the adapter never constructs its own.                                                                                                               |
| `awareness`          | `Awareness`                 | auto-created           | Presence channel. When omitted, the adapter creates one internally.                                                                                                           |
| `peer`               | `PeerInfo`                  | ephemeral              | Local identity. Omitting it mints a `local-<uuid>` id with a warn log. Provide a stable id in production.                                                                     |
| `mapName`            | `string`                    | `"default"`            | Root `Y.Map` key.                                                                                                                                                             |
| `staleAfterMs`       | `number`                    | `2000`                 | Window during which a remote update touching locally-edited nodes counts as an overlap.                                                                                       |
| `useNativeTree`      | `boolean`                   | `true`                 | Per-node CRDT merge. Set `false` only for legacy JSON-blob rooms — replicas with different modes cannot share a `Y.Doc`.                                                      |
| `connectionSource`   | `ConnectionSource`          | none                   | Host transport-event source. The host calls `emit(status)` as the provider's connection state changes.                                                                        |
| `computeDelta`       | `boolean`                   | `false`                | When `true`, every `save()` attaches a structural `IRDiff` to `SnapshotMeta.delta`.                                                                                           |
| `maxSnapshots`       | `number`                    | `200`                  | Hard ceiling on retained snapshots in the shared `Y.Doc`. Older payload+meta pairs are evicted in the same transaction as the write. Set `<= 0` to disable (not recommended). |
| `awarenessRateLimit` | `AwarenessRateLimitOptions` | `{ maxPerSecond: 30 }` | Token-bucket limiter on outbound `presence.update`. Set `maxPerSecond: Infinity` to disable.                                                                                  |
| `persistence`        | `PersistenceOptions`        | none                   | Opt-in IndexedDB queue and `BroadcastChannel` relay. Each backend feature-detects and degrades silently on SSR or older browsers.                                             |
| `undo`               | `UndoOptions`               | none                   | Opt-in local undo/redo. Wraps a `Y.UndoManager` over the live `PageIR` tree and exposes `undo`/`redo`/`canUndo`/`canRedo`/`clearUndo`/`onUndoStackChange` on the adapter. Only the local peer's edits are tracked — remote changes are never on the local stack. |
| `propGuards`         | `PropGuardOptions`          | permissive             | Bounds at the prop-decode trust boundary (`maxBytes` / `maxDepth` / `maxArrayLength` / `maxNodes`). A prop value exceeding any bound is dropped from the decoded node and recorded as a `degraded` metric. Tune down for open / multi-tenant rooms. |
| `resolveConflict`    | `ResolveConflict`           | none                   | Semantic merge hook for same-node, same-field prop conflicts. Returns `"local"`, `"remote"`, or `{ fields }`; a non-`"remote"` result is written back into the shared `Y.Doc`. Omit for last-write-wins. |
| `snapshotPersistence`| `SnapshotPersistenceOptions`| none                   | Opt-in server-grade snapshot mirror. Mirrors each `save()` / `delete()` to a `SnapshotPersistenceAdapter` with `encode` / `decode` (encryption-at-rest) hooks and best-effort `onFault`. The in-`Y.Doc` store stays the source of truth. |

### `CreateCollabPluginOptions`

| Field                   | Type                                   | Default    | Purpose                                                                                                                                        |
| ----------------------- | -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`               | `SnapshotAdapter`                      | _required_ | The CRDT adapter (usually from `createYjsAdapter`, optionally wrapped in `createDebouncedAdapter`).                                            |
| `puckConfig`            | `Config`                               | none       | Required for outbound sync (Puck → IR). Omit for read-only viewers.                                                                            |
| `localPeer`             | `PeerInfo`                             | ephemeral  | Identity used for conflict attribution, policy checks, and presence cursors. Omitting it logs a warning and mints a per-instance ephemeral id. |
| `validateRemoteIR`      | `(ir: PageIR) => PageIR \| null`       | none       | Defense-in-depth validation hook. Returning `null` or throwing rejects the update.                                                             |
| `onValidationFailure`   | `(failure: ValidationFailure) => void` | none       | Host-side observer for rejected remote IRs (toast, telemetry).                                                                                 |
| `onSaveError`           | `(error: unknown) => void`             | none       | Outbound transport-failure observer. Without it, network 5xx errors surface as `unhandledRejection`.                                           |
| `policy`                | `CollabPolicy`                         | none       | Symmetric RBAC bridge. `canEdit(node, peer)` is consulted inbound and outbound.                                                                |
| `onPolicyViolation`     | `(violation: PolicyViolation) => void` | none       | Fired when `policy.canEdit` rejects.                                                                                                           |
| `inboundScheduler`      | `InboundSchedulerHandleScheduler`      | `requestAnimationFrame` / `setTimeout` | (H1) Override the inbound coalescing scheduler. Defaults to `requestAnimationFrame` in the browser, `setTimeout` under SSR/Node. Intended for deterministic tests — do not set in production. |
| `inboundBudgetMs`       | `number`                               | `16`       | (H1) Fallback inbound-flush cadence in ms, used when `requestAnimationFrame` is unavailable.                                                   |
| `replaceBatchThreshold` | `number`                               | `50`       | Per-node `replace` dispatches below this threshold; above it the plugin falls back to a single `setData` call.                                 |
| `logger`                | `CollabLogger`                         | none       | `(level, message, meta?) => void` hook for the deprecated-alias warning and transport errors. Falls back to `console` when omitted. A custom `onSaveError` / transport `onConnectionError` still takes precedence.                                 |

### `YjsSnapshotAdapter`

Extends `SnapshotAdapter` (from `@anvilkit/plugin-version-history`) with:

| Member           | Signature                                                 | Purpose                                                                                                                                     |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `onConflict`     | `(cb: (event: ConflictEvent) => void) => Unsubscribe`     | Overlap diagnostics.                                                                                                                        |
| `onStatusChange` | `(cb: (status: ConnectionStatus) => void) => Unsubscribe` | Connection-state stream. Invoked synchronously with the current status on registration.                                                     |
| `getStatus`      | `() => ConnectionStatus`                                  | Sync read of the latest status. Prefer `onStatusChange` inside `useSyncExternalStore` in React.                                             |
| `forceResync`    | `() => Promise<PageIR \| null>`                           | Discard unsaved local edits and re-emit the latest authoritative snapshot. Resolves to `null` if no snapshot exists.                        |
| `metrics`        | `() => MetricsSnapshot`                                   | Point-in-time observability snapshot. Cheap to call at second-cadence polling.                                                              |
| `loadPersistedSnapshot` | `(id: string) => Promise<PageIR \| undefined>`     | Hydrate a snapshot's `PageIR` from the optional `snapshotPersistence` backend (applies the configured `decode`). Resolves `undefined` when no backend was supplied or it has no record of `id`. |
| `undo` / `redo` / `canUndo` / `canRedo` / `clearUndo` / `onUndoStackChange` | `UndoController` | Local undo/redo surface (active only when the `undo` option is supplied; inert otherwise). `clearUndo()` resets the stacks on document switch; `onUndoStackChange(cb)` notifies on stack mutations so hosts can re-read `canUndo()`/`canRedo()`. |
| `presence`       | `RichSnapshotAdapterPresence \| undefined`               | Narrowed from `SnapshotAdapter.presence` so `update`/`onPeerChange` carry the versioned multi-select / viewport / focused-block / typing fields with full type-checking. |
| `destroy`        | `() => void`                                              | Release internal subscriptions. Called automatically by the Studio plugin's `onDestroy` — only needed if you build a custom plugin wrapper. |

### `ConnectionStatus` (discriminated union)

```ts
type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "synced"; since: string }
  | { kind: "offline"; since: string; queuedEdits: number }
  | { kind: "reconnecting"; attempt: number; backoffMs: number }
  | { kind: "error"; message: string; recoverable: boolean; reason?: ConnectionErrorReason };

type ConnectionErrorReason = "auth" | "transport" | "timeout";
```

`queuedEdits` is populated by the adapter from its internal counter; the value the host passes is ignored.

On the `error` variant, `reason` distinguishes an authentication/authorization failure (`"auth"` — not recoverable without fresh credentials, so `recoverable` is `false`) from a generic transport fault (`"transport"`) or a connection-establishment timeout (`"timeout"`). The managed transport increments `reconnecting.attempt` and grows `backoffMs` with jitter across reconnect cycles, resetting on `synced`.

### `ConflictEvent`

```ts
interface ConflictEvent {
  kind: "overlap";
  localPeer: PeerInfo;
  remotePeer?: PeerInfo;
  nodeIds: readonly string[];
  fields?: readonly ConflictFieldDetail[];
  at: string;
}

interface ConflictFieldDetail {
  nodeId: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
}
```

`fields` enumerates the per-node, per-field prop conflicts for same-field overlaps, so a host can present a semantic merge or resolve them through the `resolveConflict` adapter option.

### `MetricsSnapshot` (selected fields)

| Field                                                                                                            | Meaning                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `saveCount`, `transportWrites`, `saveCoalescingRatio`                                                            | Save traffic and debouncer efficacy.                                                                                                   |
| `syncLatencyP50Ms`, `syncLatencyP95Ms`, `syncLatencySamples`                                                     | End-to-end latency percentiles over the last 200 samples.                                                                              |
| `awarenessChurn`, `presenceValidationFailures`                                                                   | Presence health — high churn or non-zero failures point to a misbehaving peer.                                                         |
| `inboundCoalesced`, `inboundQueueDelayP50Ms`                                                                     | Inbound coalescer activity. Non-zero `inboundCoalesced` means the adapter shielded the editor from a remote burst.                     |
| `conversionTimeP50Ms`, `dispatchTimeP50Ms`, `saveEncodeTimeP50Ms`, `nativeApplyTimeP50Ms`, `nativeReadTimeP50Ms` | Main-thread hot-path timings (P1).                                                                                                     |
| `degraded`, `degradedReasons`                                                                                    | Whether the adapter fell back from native-tree to legacy blob, and the trip reason (`cycle`/`max-depth`/`max-nodes`/`decode-failure`). |
| `dispatchFailures`                                                                                               | Number of remote `subscribe` callback invocations that threw.                                                                          |

### Encoding utilities and snapshot diff

| Export                            | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| `encodeIR(ir)` / `decodeIR(json)` | Stable JSON encoding used for snapshot payloads.      |
| `hashIR(encoded)`                 | Content hash used by `SnapshotMeta.pageIRHash`.       |
| `diffSnapshots(prev, next)`       | Structural per-node diff between two `PageIR` values. |

### Presence validation

| Export                                                                                  | Purpose                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sanitizeDisplayName(value)`                                                            | Strips `U+0000`–`U+001F` / `U+007F` and truncates to `MAX_DISPLAY_NAME_LENGTH` (64 chars). |
| `validatePeerInfo(value)`                                                               | Strict validation. Color must match the allowlist; rejection drops the entire peer record. |
| `validatePresenceState(value)` / `validatePresenceCursor` / `validatePresenceSelection` | Inbound awareness validators used by the adapter; exported for host-side defense-in-depth. `validatePresenceState` returns the richer `RichPresenceState` (multi-select + viewport + focused-block + typing). |
| `sanitizePresenceSelection(value)`                                                      | Sanitizing multi-select validator — drops non-string / empty / over-long ids and truncates to `MAX_SELECTION_IDS` instead of rejecting the whole selection. |
| `validatePresenceViewport` / `validatePresenceActivity`                                 | Validate the richer presence fields — viewport (scroll + clamped zoom) and typing/activity metadata. |
| `MAX_DISPLAY_NAME_LENGTH`                                                               | `64`.                                                                                      |
| `MAX_SELECTION_IDS` / `MAX_NODE_ID_LENGTH` / `MIN_VIEWPORT_ZOOM` / `MAX_VIEWPORT_ZOOM` / `PRESENCE_SCHEMA_VERSION` | Sanitization bounds and the presence payload schema version (`2`). |

### Errors

- `SnapshotCorruptedError`, `SnapshotNotFoundError`, `SnapshotPrunedError` — typed errors thrown from `load(id)`. `SnapshotCorruptedError` is also thrown when a decoded snapshot payload/meta fails strict validation (bad payload version, malformed delta op, non-finite timestamp, empty id).
- `DebouncedAdapterDestroyedError` — thrown when methods are called on a `createDebouncedAdapter` instance after `destroy()`.
- `InvalidAdapterOptionsError` — thrown by `createYjsAdapter` at construction for an empty/blank/non-string `mapName` or a missing local `peer.id`.

### React bridge

- `usePuckSelection()` — maps Puck's selected component into `PresenceSelection` for outbound awareness updates. Use inside a host component mounted within `<Puck>`.
- `usePuckMultiSelection(extraNodeIds?)` — merges the single Puck selection (primary, first) with host-tracked additional ids into a multi-id `PresenceSelection`, de-duplicated, sanitized, and bounded to `MAX_SELECTION_IDS`. Returns `null` when the merged selection is empty.

## Usage examples

### In-memory test harness

```ts
import { Awareness } from "y-protocols/awareness";
import { Doc as YDoc } from "yjs";
import { createYjsAdapter } from "@anvilkit/plugin-collab-yjs";

const doc = new YDoc();
const awareness = new Awareness(doc);
const adapter = createYjsAdapter({
  doc,
  awareness,
  peer: { id: "test-user", displayName: "Test" },
});

// In tests, the adapter starts in `connecting` and flips to `synced`
// on the first subscribe() registration, so no transport plumbing is
// needed for unit tests.
adapter.subscribe((ir) => {
  console.log("emitted IR", ir);
});
```

### Host-driven connection status

```ts
import type { ConnectionSource } from "@anvilkit/plugin-collab-yjs";
import { WebsocketProvider } from "y-websocket";

let queuedEdits = 0;

const connectionSource: ConnectionSource = (emit) => {
  const onStatus = (e: { status: string }) => {
    if (e.status === "connected") emit({ kind: "connecting" });
    if (e.status === "disconnected") {
      emit({
        kind: "offline",
        since: new Date().toISOString(),
        queuedEdits,
      });
    }
  };
  const onSync = (synced: boolean) => {
    if (synced) emit({ kind: "synced", since: new Date().toISOString() });
  };
  provider.on("status", onStatus);
  provider.on("sync", onSync);
  return () => {
    provider.off("status", onStatus);
    provider.off("sync", onSync);
  };
};

createYjsAdapter({ doc, awareness, connectionSource });
```

### Force resync flow

```ts
const forceResync = async () => {
  const restored = await adapter.forceResync();
  if (restored === null) {
    toast.warn("No snapshot to restore from.");
    return;
  }
  toast.success("Reloaded the latest collaborative snapshot.");
};
```

### Policy + validation hooks

```ts
import type {
  CollabPolicy,
  ValidateRemoteIR,
} from "@anvilkit/plugin-collab-yjs";

const policy: CollabPolicy = {
  canEdit: (node, peer) => {
    if (node.props?.locked === true) return peer.id === node.props.lockedBy;
    return true;
  },
};

const validateRemoteIR: ValidateRemoteIR = (ir) => {
  if (!ir.root || typeof ir.root !== "object") return null;
  if (ir.version !== "1") return null;
  return ir;
};

createCollabDataPlugin({
  adapter,
  puckConfig,
  localPeer,
  policy,
  validateRemoteIR,
  onPolicyViolation: (v) => telemetry.warn("policy-violation", v),
  onValidationFailure: (f) => telemetry.warn("validation-failure", f),
});
```

## Notes & FAQ

### Native-tree vs legacy JSON-blob

Native-tree (`useNativeTree: true`, the default) mirrors the live `PageIR` as a flat-addressed `Y.Map` tree — one `Y.Map` per node, plus a `childIds` `Y.Array` per parent. Same-node edits still fall back to per-key LWW; different-node edits merge cleanly.

The legacy whole-document JSON-blob encoding under a single `pageIR` key is preserved as a fallback. `save()` writes both representations so a tree-aware adapter and a blob-aware adapter can read the same snapshot. **You cannot mix encodings in one `Y.Doc`** — pick one mode per room.

**Migration is automatic.** Adapters constructed on a `Y.Doc` that only has the legacy blob (no native-tree state) hydrate the tree from the blob at construction time. The migration is one-shot, transactional, and idempotent — subsequent adapters short-circuit. Hosts upgrading from a pre-`0.10` version can roll the new adapter without a separate migration step.

### Presence is untrusted input

The adapter validates every inbound `PresenceState` through `validatePresenceState`. Two specific hardenings:

- **`color` allowlist.** Anything that doesn't match `#rgb` / `#rrggbb` / `#rrggbbaa`, `rgb(...)`, `rgba(...)`, or the named-color set is rejected — including `javascript:`, `expression(...)`, `<script>`, and arbitrary strings. Rejection drops the entire peer record so a malicious peer cannot smuggle a payload with only the safe parts.
- **`displayName` sanitization.** `sanitizeDisplayName` strips ASCII control characters and truncates to 64 chars. It does **not** HTML-escape — if your UI injects the name via `innerHTML`, escape at the rendering boundary.

`MetricsSnapshot.presenceValidationFailures` counts rejected peers so hosts can alert on a noisy or hostile room without inspecting individual payloads.

### `createDebouncedAdapter` requires `destroy()`

The wrapper holds a pending-timer reference. Call `destroy()` on unmount to cancel pending timers and forward teardown to the wrapped adapter. Methods called after `destroy()` throw `DebouncedAdapterDestroyedError`.

### Reference transport and production deployment

A minimal relay lives under `examples/y-websocket-server.mjs` in this repository (source-only, not in the published npm package):

```bash
# Defaults to ws://127.0.0.1:21234
node packages/plugins/plugin-collab-yjs/examples/y-websocket-server.mjs

# Override the port (positional arg or COLLAB_RELAY_PORT), or bind a
# non-loopback host with COLLAB_RELAY_HOST:
node packages/plugins/plugin-collab-yjs/examples/y-websocket-server.mjs 21300
```

The relay listens on **port 21234 by default** (1234 and 11234 are avoided because Windows/WSL2 reserves them). Because `y-websocket@3` dropped its bundled server (`y-websocket/bin/utils`) and `@y/websocket-server` targets the incompatible `yjs-14` line, this relay **vendors the classic `y-protocols` sync/awareness server inline against the `yjs-13` stack** — wire-compatible with the demo's `y-websocket@3` client and independent of `y-websocket`'s server packaging. It is a reference for tests and demos, not a production server.

For production deployments — auth, durable Postgres persistence, and Redis-backed horizontal scale-out via [Hocuspocus](https://tiptap.dev/hocuspocus) — follow the recipe at [`docs/hocuspocus-deployment.md`](./docs/hocuspocus-deployment.md).

### Production deployment & authorization

Authorization is **two layers**, and the plugin treats both as the source of truth — neither replaces the other:

1. **Relay-level authentication (who may connect).** The websocket upgrade itself is gated by the relay. With [Hocuspocus](https://tiptap.dev/hocuspocus) this is the `onAuthenticate({ token })` hook — throw to reject the connection (it closes the socket). Tokens are forwarded from the client via the provider's `token` option (or `createManagedTransport({ token })`). See [`docs/hocuspocus-deployment.md`](./docs/hocuspocus-deployment.md) for an authenticated `server.mjs` plus the matching client wiring.

2. **Application-level authorization (who may edit what).** Per-node edit rights are enforced **client-side and symmetrically** through the [`policy.canEdit(node, peer)`](#policy--validation-hooks) hook — outbound before every `save()`, inbound after `validateRemoteIR`. A rejection drops the change and fires `onPolicyViolation`. Mirror the same checks in the relay's `onChange` hook (server-side defense-in-depth) so a peer that bypasses the client cannot smuggle an unauthorized update past the policy.

**A relay auth failure is a first-class, distinguishable connection error.** When the managed transport's Hocuspocus provider emits `authenticationFailed`, it surfaces as a typed `ConnectionStatus`:

```ts
import type { ConnectionStatus } from "@anvilkit/plugin-collab-yjs";

function onStatus(status: ConnectionStatus) {
  if (status.kind === "error" && status.reason === "auth") {
    // Non-recoverable without new credentials (status.recoverable === false).
    // Prompt re-authentication rather than a blind retry.
    promptReauth();
  }
}
```

The `error` variant carries an optional `reason: "auth" | "transport"` discriminator (absent ⇒ `"transport"`). Auth failures (`reason: "auth"`) are emitted with `recoverable: false`, so a host can prompt for fresh credentials instead of showing a transient reconnect indicator; every other connection-level fault stays `reason: "transport"`. Hosts that build a bespoke `connectionSource` against a raw `HocuspocusProvider` should map its `authenticationFailed` event to `{ kind: "error", reason: "auth", recoverable: false }` to get the same UX — see the client-wiring example in [`docs/hocuspocus-deployment.md`](./docs/hocuspocus-deployment.md).

### Performance characteristics

- **Remote edits — incremental.** A remote prop edit re-reads only the touched nodes. A reorder/insert/delete emits a structured relink delta so the live-IR cache relinks only the affected parents + added nodes, reusing every untouched node's already-parsed props. A genuine whole-document change still falls back to a full guarded rebuild — the correctness backstop.
- **Local `save()` — O(changed) apply, O(document) floor.** The Y.Doc apply writes only changed/added nodes and deletes removed ones. The residual O(document) cost is the `encodeIR(ir)` snapshot payload string written every save; `SnapshotMeta.pageIRHash` keeps its `hashIR(encodeIR(ir))` definition.
- **Residual tail costs.** Snapshot meta re-scan O(`maxSnapshots`) per save, pending-index rebuild O(document) under interleaved remote bursts during active typing, conflict overlap O(document) per remote flush when an `onConflict` listener is attached, and wide-child-list reconciliation O(n²) for parents with thousands of children. All gated by `pnpm bench:collab-highload`.

Budget guidance: pages up to a few thousand nodes with the default `maxSnapshots` stay comfortably within frame budget.

### Cross-tab persistence is opt-in

Both `persistence.indexedDb` and `persistence.broadcastChannel` default to `false`. When enabled, each backend feature-detects at construction time and degrades silently if its API is unavailable (SSR, older browsers, certain test runners). Use `persistence.onFault` to learn about quota or schema faults — the adapter never throws out of persistence into the `Y.Doc` observer chain.

### Server-grade snapshot persistence is pluggable

Snapshot-level persistence (a durable, full-state dump that outlives the bounded in-`Y.Doc` `maxSnapshots` window — for fast tab bootstrap or a server-side history store) is an **optional injection point** rather than a built-in backend. Pass `snapshotPersistence: { adapter }` to `createYjsAdapter`, where `adapter` implements the `SnapshotPersistenceAdapter` interface:

```ts
import {
  createYjsAdapter,
  type SnapshotPersistenceAdapter,
} from "@anvilkit/plugin-collab-yjs";

const backend: SnapshotPersistenceAdapter = {
  saveSnapshot: (meta, payload) => db.put(meta.id, { meta, payload }),
  loadSnapshot: (id) => db.get(id).then((r) => r?.payload),
  listSnapshots: () => db.all(),
  deleteSnapshot: (id) => db.delete(id),
};

const adapter = createYjsAdapter({
  doc,
  snapshotPersistence: {
    adapter: backend,
    // Encryption-at-rest seam — supply a real cipher pair. `decode(encode(x)) === x`.
    encode: (payload) => cipher.encrypt(payload),
    decode: (payload) => cipher.decrypt(payload),
    onFault: (op, err) => telemetry.warn("snapshot-persistence", { op, err }),
  },
});

// Hydrate the durable, full-state snapshot independently of the bounded in-Y.Doc window:
const ir = await adapter.loadPersistedSnapshot(id);
```

The in-`Y.Doc` snapshot store remains the **source of truth and the default** — supplying `snapshotPersistence` only *mirrors* each `save()` (a self-contained payload + `SnapshotMeta`) and each explicit `delete()` to the backend. Mirroring is best-effort: a backend throw/reject surfaces through `onFault` and never blocks or rejects the in-`Y.Doc` write. Retention evictions (`maxSnapshots`) are deliberately **not** mirrored, so the durable store can retain history the CRDT has pruned. The `encode`/`decode` pair is the documented **encryption-at-rest** seam (the adapter ships no crypto of its own).

Cross-origin / iframe persistence is explicitly out of scope — `BroadcastChannel` is same-origin and that is the correct boundary for an editor.

### See also

- The `realtime-collab` architecture doc on the Anvilkit docs site — full design and threat model.
- [CHANGELOG.md](./CHANGELOG.md) — per-release notes.
- [`@anvilkit/collab-ui`](../plugin-collab-ui/README.md) — React presentation layer + consolidated `createCollabPlugin` factory.
