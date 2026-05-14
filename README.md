# @anvilkit/plugin-collab-yjs

> **Beta channel.** This package ships under the `@beta` npm dist-tag
> through the Phase 1 cycle (v0.10.x). Per-node CRDT merge via
> `useNativeTree` is now the default; hosts can opt back into the
> legacy whole-document JSON encoding with `useNativeTree: false` for
> backward-compatible rooms. See `docs/policies/lts.md` for the GA
> timeline.

A first-party Anvilkit Studio plugin that proves the
`SnapshotAdapter` v2 contract can host live CRDT state alongside Puck
without forking Core or Puck. Built on
[Yjs](https://github.com/yjs/yjs) and
[`y-protocols/awareness`](https://github.com/yjs/y-protocols).

## Usage

> **Naming note.** Since v0.10.0 the data-only factory previously
> exported as `createCollabPlugin` is named `createCollabDataPlugin`.
> The legacy name remains available as a deprecated alias (one minor
> release) so existing code keeps compiling; it logs a one-shot
> `console.warn` on first call. For the *full* data + UI bundle, import
> `createCollabPlugin` from `@anvilkit/plugin-collab-ui` instead.

```ts
import {
  createCollabDataPlugin,
  createDebouncedAdapter,
  createYjsAdapter,
} from "@anvilkit/plugin-collab-yjs";
import { Doc as YDoc } from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new YDoc();
const provider = new WebsocketProvider("ws://localhost:1234", "demo-room", doc);

const adapter = createYjsAdapter({
  doc,
  awareness: provider.awareness,
  peer: { id: "alice", displayName: "Alice", color: "#f43f5e" },
  // Native-tree is the default (L1). Disjoint concurrent edits to
  // different nodes merge cleanly instead of LWW-overwriting each
  // other. Pass `useNativeTree: false` only for legacy rooms that
  // still run the JSON-blob encoding — pick one mode per room;
  // native-tree replicas and JSON-blob replicas cannot share a Y.Doc.
});

// Optional: coalesce slider drags / rapid typing into one write per
// debounce window (default 150ms).
const debounced = createDebouncedAdapter(adapter, { ms: 150 });

registerPlugins([
  createCollabDataPlugin({
    adapter: debounced,
    puckConfig: myPuckConfig,
    // REQUIRED for multi-peer rooms. Omitting localPeer makes the
    // plugin mint an ephemeral `local-<uuid>` id and log a warning,
    // but a stable id per user is necessary for conflict attribution,
    // policy enforcement, and presence cursors.
    localPeer: { id: "alice", displayName: "Alice", color: "#f43f5e" },
    // Defense-in-depth — every transport is treated as untrusted.
    // Returning null or throwing rejects the remote update.
    validateRemoteIR: (ir) => (isWellFormed(ir) ? ir : null),
    onValidationFailure: (failure) => toast(`Rejected: ${failure.kind}`),
    // Surface outbound transport failures (network blip, backend
    // 5xx, etc.) so they don't disappear into unhandledRejection.
    onSaveError: (error) => toast(`Save failed: ${error}`),
  }),
]);

// Phase 1 (D2): subscribe to overlap diagnostics for host UI toasts.
adapter.onConflict((event) => {
  toast(`Edit overlapped on nodes: ${event.nodeIds.join(", ")}`);
});
```

## Encoding

By default the live `PageIR` is mirrored as a flat-addressed `Y.Map`
tree (one `Y.Map` per node, plus a `childIds` `Y.Array` per parent).
Concurrent edits to **different** node ids merge cleanly via Y.js per-
key CRDT semantics. Edits to the *same* node still rely on Y.Map
prop-level LWW.

The legacy whole-document JSON encoding under a single `pageIR` `Y.Map`
key is preserved as a fallback — `save()` writes both representations
so a tree-aware adapter and a blob-aware adapter can read the same
snapshot. Set `useNativeTree: false` to opt back into the JSON-blob
encoding (LWW on the whole document, lossier under concurrent edits to
disjoint nodes).

**Migration.** Adapters constructed on a Y.Doc that only has the legacy
JSON-blob payload (and no native-tree state) automatically hydrate the
tree from the blob at construction time. The migration is one-shot,
transactional, and idempotent — subsequent adapters short-circuit.
Hosts upgrading from a pre-L1 version can roll the new adapter without
a separate migration step.

Each saved snapshot also gets its own `snapshotMeta:<id>` and
`snapshotPayload:<id>` keys so the adapter can satisfy the
`SnapshotAdapter` history contract regardless of the live encoding.

### Snapshot diff (L2)

Pass `computeDelta: true` and every `save()` attaches an `IRDiff` to
the resulting `SnapshotMeta.delta`. Useful for audit logs, change-
summary UIs (`summarizeDiff(meta.delta)` from
`@anvilkit/plugin-version-history` returns a human string), and
undo-stack replay. The first save's delta is computed against the
empty document; subsequent saves are computed against the previous
locally saved IR. Off by default to preserve write performance.

See [`docs/architecture/realtime-collab.md`](../../../docs/architecture/realtime-collab.md)
for the full design and threat model.

## Presence security

Awareness payloads ride an untrusted transport. The adapter validates
every inbound `PresenceState` through `validatePresenceState`, which
delegates to `validatePeerInfo` for the peer record. Two specific
hardenings are worth knowing about when you render presence data into
the DOM:

- **`color` allowlist.** Anything that doesn't match `#rgb` / `#rrggbb`
  / `#rrggbbaa`, `rgb(...)`, `rgba(...)`, or a small named-color set is
  rejected — including `javascript:`, `expression(...)`, `<script>...`,
  and arbitrary strings. Rejection drops the entire peer record (not
  just the color field) so a malicious peer cannot smuggle a payload
  with only the safe parts.
- **`displayName` sanitization.** `sanitizeDisplayName` strips ASCII
  control characters (`U+0000`–`U+001F` and `U+007F`) and truncates to
  `MAX_DISPLAY_NAME_LENGTH` (64 chars). It does **not** HTML-escape —
  if your UI injects the name via `innerHTML` or templates that don't
  auto-escape, escape at the rendering boundary.

```ts
import {
  MAX_DISPLAY_NAME_LENGTH,
  sanitizeDisplayName,
} from "@anvilkit/plugin-collab-yjs";

// Belt-and-suspenders: sanitize at construction time too.
const localPeer = {
  id: "alice",
  displayName: sanitizeDisplayName(userInput),
  color: "#f43f5e",
};
```

`MetricsSnapshot.presenceValidationFailures` counts how many inbound
peer records were rejected, so hosts can alert on a noisy or hostile
room without inspecting individual payloads.

## Reference transport

A minimal `y-websocket` relay lives under `examples/` in this
repository. The examples directory is source-only and is not included
in the published npm package:

```bash
node packages/plugins/plugin-collab-yjs/examples/y-websocket-server.mjs
```

For production deployments — auth, durable Postgres persistence, and
Redis-backed horizontal scale-out via
[Hocuspocus](https://tiptap.dev/hocuspocus) — follow the recipe at
[`docs/hocuspocus-deployment.md`](./docs/hocuspocus-deployment.md).

## Phases and roadmap

### Shipped — `0.10.0-rc.0` (2026-05-14)

- **L1** — Native-tree is now the default encoding. Per-node CRDT
  merge replaces whole-document LWW. Legacy JSON-blob rooms can opt
  back in via `useNativeTree: false`; migration from JSON-blob to
  native-tree happens automatically at construction time.
- **L2** — Snapshot diff API. `SnapshotMeta.delta` carries a
  structural per-node diff when `computeDelta: true`; powers audit
  logs and undo-stack replay.
- **L3** — Awareness rate-limit (default 30/sec) and 5-minute
  sliding-window churn metric. Caps awareness traffic from misbehaving
  hosts.
- **L5** — Cross-tab persistence. Opt-in IndexedDB queue + same-origin
  `BroadcastChannel` relay. Survives brief disconnects, syncs two
  tabs of the same app without round-tripping through the transport.
- **L6** — Hocuspocus production deployment recipe with auth,
  Postgres persistence, and Redis scale-out. See
  [`docs/hocuspocus-deployment.md`](./docs/hocuspocus-deployment.md).

### Shipped — `0.9.0-rc.1` (2026-05-13)

GA-stabilization round closing 24 issues from the 2026-05-13 code
review. Lifecycle/cleanup hardening, echo-detection collision fix,
per-instance peer-id fallback, presence security (color allowlist +
displayName sanitization), metrics enrichment, and a no-behavior-
change refactor of `yjs-adapter.ts` into per-concern modules. See
CHANGELOG.

### In progress / next

- **L4 / longer-term docs.** This roadmap section, CHANGELOG voice
  alignment with sibling plugins.

### Deferred

- **Update compaction.** `Y.mergeUpdatesV2` on the IDB queue once it
  exceeds N entries. Currently the queue accumulates until reconnect
  drains it.
- **Snapshot-level persistence.** Full state dump for fast tab
  bootstrap without replaying every update.
- **Encryption at rest** for the IDB queue.
- **Cross-origin / iframe persistence.** Explicitly out of scope —
  `BroadcastChannel` is same-origin and that is the correct boundary
  for an editor.

## Stabilization round 2026-05-13 (`0.9.0-rc.1`)

This release closed the lifecycle, echo-detection, and peer-fallback
defects raised in the 2026-05-13 code review, plus tightened metrics,
presence security, and the `yjs-adapter` internal architecture. See
[CHANGELOG.md](./CHANGELOG.md) for the full list. Key behavior changes
for hosts:

- `createDebouncedAdapter` now has a `destroy()` method — call it on
  unmount to cancel pending timers and forward teardown.
- `createCollabDataPlugin({ onSaveError })` lets you surface outbound
  save failures (previously they became unhandled rejections). Still
  available under the deprecated alias `createCollabPlugin` for one
  more minor release.
- Omitting `localPeer` now mints a per-instance ephemeral id with a
  warn log instead of colliding all clients on `id: "local"`.
- `validatePeerInfo` now enforces a color allowlist and a 64-char
  displayName cap with control-character stripping.
- `MetricsSnapshot` gains `presenceValidationFailures`; the
  `awarenessChurn` counter is now a 5-minute sliding window (L3).
- Outbound `presence.update` is token-bucket rate-limited (default
  30/sec, configurable via `awarenessRateLimit.maxPerSecond`; L3).
