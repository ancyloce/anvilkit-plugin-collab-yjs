# @anvilkit/plugin-collab-yjs

> **Release candidate (`0.10.x`).** Ships under the `@next` npm dist-tag. Per-node CRDT merge (`useNativeTree`) is now the default. See `docs/policies/lts.md` for the GA timeline.

A first-party Anvilkit Studio plugin that proves the `SnapshotAdapter` v2 contract can host live CRDT state alongside Puck without forking Core or Puck. Built on [Yjs](https://github.com/yjs/yjs) and [`y-protocols/awareness`](https://github.com/yjs/y-protocols), it ships the data layer only — pair it with `@anvilkit/collab-ui` for the React presentation layer or compose your own UI on top of the public hooks.

## Installation

```bash
pnpm add @anvilkit/plugin-collab-yjs yjs y-protocols react react-dom @puckeditor/core
```

`yjs` and `y-protocols` are direct runtime dependencies. `react`, `react-dom`, and `@puckeditor/core` are non-optional peers — the plugin runs inside the Studio shell. For a transport, install `y-websocket` (demos) or wire your own provider (Hocuspocus, custom WebRTC, etc.).

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

### `YjsSnapshotAdapter`

Extends `SnapshotAdapter` (from `@anvilkit/plugin-version-history`) with:

| Member           | Signature                                                 | Purpose                                                                                                                                     |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `onConflict`     | `(cb: (event: ConflictEvent) => void) => Unsubscribe`     | Overlap diagnostics.                                                                                                                        |
| `onStatusChange` | `(cb: (status: ConnectionStatus) => void) => Unsubscribe` | Connection-state stream. Invoked synchronously with the current status on registration.                                                     |
| `getStatus`      | `() => ConnectionStatus`                                  | Sync read of the latest status. Prefer `onStatusChange` inside `useSyncExternalStore` in React.                                             |
| `forceResync`    | `() => Promise<PageIR \| null>`                           | Discard unsaved local edits and re-emit the latest authoritative snapshot. Resolves to `null` if no snapshot exists.                        |
| `metrics`        | `() => MetricsSnapshot`                                   | Point-in-time observability snapshot. Cheap to call at second-cadence polling.                                                              |
| `destroy`        | `() => void`                                              | Release internal subscriptions. Called automatically by the Studio plugin's `onDestroy` — only needed if you build a custom plugin wrapper. |

### `ConnectionStatus` (discriminated union)

```ts
type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "synced"; since: string }
  | { kind: "offline"; since: string; queuedEdits: number }
  | { kind: "reconnecting"; attempt: number; backoffMs: number }
  | { kind: "error"; message: string; recoverable: boolean };
```

`queuedEdits` is populated by the adapter from its internal counter; the value the host passes is ignored.

### `ConflictEvent`

```ts
interface ConflictEvent {
  kind: "overlap";
  localPeer: PeerInfo;
  remotePeer?: PeerInfo;
  nodeIds: readonly string[];
  at: string;
}
```

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
| `validatePresenceState(value)` / `validatePresenceCursor` / `validatePresenceSelection` | Inbound awareness validators used by the adapter; exported for host-side defense-in-depth. |
| `MAX_DISPLAY_NAME_LENGTH`                                                               | `64`.                                                                                      |

### Errors

- `SnapshotCorruptedError`, `SnapshotNotFoundError`, `SnapshotPrunedError` — typed errors thrown from `load(id)`.
- `DebouncedAdapterDestroyedError` — thrown when methods are called on a `createDebouncedAdapter` instance after `destroy()`.

### React bridge

- `usePuckSelection()` — maps Puck's selected component into `PresenceSelection` for outbound awareness updates. Use inside a host component mounted within `<Puck>`.

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

### Performance characteristics

- **Remote edits — incremental.** A remote prop edit re-reads only the touched nodes. A reorder/insert/delete emits a structured relink delta so the live-IR cache relinks only the affected parents + added nodes, reusing every untouched node's already-parsed props. A genuine whole-document change still falls back to a full guarded rebuild — the correctness backstop.
- **Local `save()` — O(changed) apply, O(document) floor.** The Y.Doc apply writes only changed/added nodes and deletes removed ones. The residual O(document) cost is the `encodeIR(ir)` snapshot payload string written every save; `SnapshotMeta.pageIRHash` keeps its `hashIR(encodeIR(ir))` definition.
- **Residual tail costs.** Snapshot meta re-scan O(`maxSnapshots`) per save, pending-index rebuild O(document) under interleaved remote bursts during active typing, conflict overlap O(document) per remote flush when an `onConflict` listener is attached, and wide-child-list reconciliation O(n²) for parents with thousands of children. All gated by `pnpm bench:collab-highload`.

Budget guidance: pages up to a few thousand nodes with the default `maxSnapshots` stay comfortably within frame budget.

### Cross-tab persistence is opt-in

Both `persistence.indexedDb` and `persistence.broadcastChannel` default to `false`. When enabled, each backend feature-detects at construction time and degrades silently if its API is unavailable (SSR, older browsers, certain test runners). Use `persistence.onFault` to learn about quota or schema faults — the adapter never throws out of persistence into the `Y.Doc` observer chain.

Snapshot-level persistence (full state dump for fast tab bootstrap) and encryption at rest for the IDB queue are deferred. Cross-origin / iframe persistence is explicitly out of scope — `BroadcastChannel` is same-origin and that is the correct boundary for an editor.

### See also

- The `realtime-collab` architecture doc on the Anvilkit docs site — full design and threat model.
- [CHANGELOG.md](./CHANGELOG.md) — per-release notes.
- [`@anvilkit/collab-ui`](../plugin-collab-ui/README.md) — React presentation layer + consolidated `createCollabPlugin` factory.
