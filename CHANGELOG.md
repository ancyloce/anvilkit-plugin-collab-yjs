# @anvilkit/plugin-collab-yjs

## 0.10.0-rc.0 — 2026-05-14

Long-term plan execution (L1-L6 from
`docs/plan/plugin-collab-yjs-development-plan-2026-05-13.md`). Closes
the GA story on encoding default, snapshot diff API, presence
hardening, cross-tab persistence, and Hocuspocus production guidance.
193 unit tests + 5 integration tests passing.

### Breaking-ish

- **L1 — Native-tree is now the default encoding.** New rooms get the
  flat-addressed `Y.Map` mirror automatically; concurrent edits to
  disjoint nodes merge cleanly via Y.js per-key CRDT semantics
  instead of LWW-clobbering each other. Hosts running legacy rooms
  can opt back into the JSON-blob encoding by passing
  `useNativeTree: false`. Adapters constructed on a Y.Doc that only
  has the legacy `pageIR` JSON-blob payload migrate the tree at
  construction time — one-shot, transactional, idempotent — so no
  manual migration step is required.

### Added

- **L2 — Snapshot diff API.** `SnapshotMeta.delta?: IRDiff` (additive
  optional field) carries a structural per-node diff against the
  previous snapshot when the adapter is constructed with
  `computeDelta: true`. Useful for audit logs, change-summary UIs,
  and undo-stack replay. The `diffSnapshots(prev, next)` helper is
  re-exported for hosts that want to diff arbitrary IR pairs.
- **L3 — Awareness rate-limit and bounded churn.** Outbound
  `presence.update` calls now flow through a token-bucket limiter
  (default 30/sec, configurable via
  `awarenessRateLimit.maxPerSecond`). Local cursor-on-every-mousemove
  loops no longer flood the awareness channel. The
  `MetricsSnapshot.awarenessChurn` sliding window widened from 60s
  to 5 minutes so short idle gaps don't zero the signal.
- **L5 — Cross-tab persistence (IndexedDB + BroadcastChannel).**
  Opt-in via the new `persistence` option on `createYjsAdapter`. Two
  toggles:
  - `persistence.indexedDb: true` durably queues outbound Y.js
    updates so a brief disconnect doesn't lose unflushed edits.
    Updates replay on reconnect via the existing `synced` transition.
    On adapter construction, leftover updates from a prior session
    hydrate into the Y.Doc before the first `subscribe()` emission.
  - `persistence.broadcastChannel: true` relays Y.Doc updates to
    other tabs on the same origin so two tabs of the same app see
    each other's edits without round-tripping through the transport.
    A per-adapter `instanceId` echo guard drops self-loops.
  Both backends feature-detect at construction time and degrade
  silently to no-ops when the underlying API is unavailable (SSR,
  older Node versions, certain test environments). Quota errors,
  schema-version mismatches, and `BroadcastChannel` construction
  failures route through the optional `persistence.onFault`
  callback. When persistence is enabled,
  `getStatus().queuedEdits` reads directly from the IDB queue.
- **L6 — Hocuspocus deployment recipe.** New
  `docs/hocuspocus-deployment.md` documents production-ready
  deployment with auth (`onAuthenticate` hook), durable Postgres
  persistence (`@hocuspocus/extension-database`), horizontal
  scale-out (`@hocuspocus/extension-redis`), and the
  `connectionSource` wiring between `HocuspocusProvider` and the
  adapter's `ConnectionStatus` surface. README now links to it from
  the "Reference transport" section.

### Deferred (future work captured in code)

- Update compaction (`Y.mergeUpdatesV2` once the IDB queue exceeds
  N entries) — currently the queue accumulates until reconnect
  drains it.
- Snapshot-level persistence (full state dump for fast tab bootstrap
  without replaying every update).
- Encryption at rest for the IDB queue.

## 0.9.0-rc.1 — 2026-05-13

GA-stabilization round addressing 24 issues raised in the 2026-05-13
code review. Every fix landed with regression tests; the public API
surface (`createYjsAdapter`, `createCollabPlugin`,
`createDebouncedAdapter`, `YjsSnapshotAdapter`,
`CreateCollabPluginOptions`) is unchanged except for two additive
options (`onSaveError`, `presenceValidationFailures` in
`MetricsSnapshot`).

### Fixed

- **C1 — Lifecycle leak.** `createYjsAdapter.destroy()` now releases
  the `Y.Map` observer, the optional `treeRoot` deep observer, and the
  awareness `change` handler. Anonymous handlers were hoisted to named
  consts so `awareness.off(...)` has a reference to pass. Hosts that
  re-mount `<Studio>`, switch rooms, or wrap with the debounced adapter
  no longer leak observers, closures, or peer-listener entries per cycle.
- **C2 — Debounced adapter destroy.** `createDebouncedAdapter` now
  exposes `destroy()`. It cancels the pending flush timer, rejects
  in-flight `save()` promises with `DebouncedAdapterDestroyedError`,
  and forwards to the upstream adapter's optional `destroy`. Post-destroy
  `save()` calls reject immediately instead of queuing into a dead timer.
- **C3 — Unhandled save promise.** `createCollabPlugin` now catches
  both synchronous throws and async rejections from `adapter.save`.
  Failures route through `ctx.log("error", …)` and the new
  `options.onSaveError` hook instead of producing `unhandledRejection`
  warnings.
- **H1 — Echo-detection collision.** The plugin's local-echo detector
  is now a `Map<string, { count; addedAt }>` reference-counted by
  Puck-data key. Two identical remote dispatches followed by one real
  local edit no longer drop the local edit (the previous
  `string[] + indexOf` scheme was ambiguous when two echoes matched).
  Entries older than 60 seconds are swept on every touch so the map
  cannot grow unboundedly.
- **H2 — Peer-id fallback.** Each plugin instance now mints its own
  ephemeral `local-<uuid>` peer id when `options.localPeer` is omitted,
  and emits a one-time `warn` log in `onInit`. The previous shared
  `FALLBACK_LOCAL_PEER = { id: "local" }` constant caused every client
  that omitted `localPeer` to share the same id, which
  `isLocalOrigin(...)` then treated as local-origin — silently
  collapsing multi-peer sessions to one user.
- **M2 — Conflict window resetting on every save.** Conflict detection
  now measures elapsed time from the FIRST local save in the
  unconfirmed window, not the most-recent. Bursts of local saves can
  no longer keep extending the suppression interval indefinitely. The
  window closes on observer fire, `synced` status transition, and
  `forceResync`.
- **M5 — enforcePolicy walks the tree on every save.** `canEdit`
  decisions are now memoized per `(node.id, peer.id)` within a single
  enforcement pass. Large IRs with repeated nodes no longer pay the
  cost of duplicate `canEdit` invocations. The cache is per-call only
  so policy state changes between calls always take effect.
- **M6 — Per-prop double `JSON.stringify` in native-tree diff.**
  `reconcileProps` now precomputes the baseline encoded map once per
  call instead of stringifying each baseline value once per prop
  iteration.
- **M7 — `load(id)` error context.** `decodeIR` failures are now
  re-thrown with the snapshot id in the message and the original error
  wired as `cause`, so a corrupted payload surfaces a debuggable error
  instead of a raw decode exception.
- **L5 — `recordLatencySample` rename.** Internal function renamed to
  `recordObservationLatency` to reflect that the measurement is taken
  at observer-fire time, before subscriber listeners run.

### Added

- **`options.onSaveError`** on `CreateCollabPluginOptions`. Fires when
  an outbound `adapter.save()` rejects or throws. Hosts wire it to
  toasts, telemetry, or retry queues.
- **`MetricsSnapshot.presenceValidationFailures`** (L7). Counts
  awareness payloads rejected by `validatePresenceState`. Surfaces
  schema drift and misbehaving peers in telemetry instead of silently
  dropping them.
- **`MetricsSnapshot.queuedEdits` semantics** (M1). When the host's
  `connectionSource` emits an `offline` event, the adapter substitutes
  its own counter of local saves since the last `synced` transition.
  Hosts always see an accurate CRDT-derived queue depth instead of
  whatever the transport thought it had buffered.
- **`sanitizeDisplayName` and `MAX_DISPLAY_NAME_LENGTH` exports**
  (M4). Strip ASCII control characters and cap to 64 chars. Used
  inside `validatePeerInfo` and also exported for host reuse.
- **`pnpm test:integration` script** (L4). Runs subprocess-spawning
  tests under `src/**/*.integration.test.ts` against
  `vitest.integration.config.ts`. Default `pnpm test` excludes them
  so the unit suite stays fast on slow CI runners.

### Changed

- **Architecture: `yjs-adapter.ts` split into six focused modules**
  (H3). The previous 501-line god-closure was refactored into
  `keys.ts`, `metrics.ts`, `connection-status.ts`, `conflicts.ts`,
  `snapshots.ts`, and `awareness-bridge.ts`. The public factory is
  now ~150 LOC and owns only the Y observer wiring and module
  composition. Closes L6 (magic-string Y.Map keys are now in
  `keys.ts`).
- **`MetricsSnapshot.awarenessChurn`** (L1). Replaced the unbounded
  monotonic counter with a 60-second sliding window. Long sessions
  no longer get a meaningless ever-growing number.
- **`presence-schema` color allowlist** (M4). `validatePeerInfo` now
  rejects color strings that don't match `#rgb`, `#rrggbb`,
  `#rrggbbaa`, `rgb(...)`, `rgba(...)`, or a small named-color
  allowlist (`red`, `transparent`, etc.). XSS sinks like
  `javascript:alert(1)` and `expression(...)` are rejected at
  validation time so hosts that render `color` into a CSS attribute
  get defense-in-depth.
- **`ConnectionStatus.offline.queuedEdits` JSDoc** (M1 docs portion).
  Clarified the field is populated by the adapter when emitting
  `offline` events.

### Notes

- **L2 is partial.** Moving `snapshotCounter` into the closure broke
  deterministic LWW ordering for sibling adapters in the same process
  (round-trip fuzzer and partition harness rely on ids being globally
  monotonic). The counter remains module-scoped with an explanatory
  comment.
- **L3** is folded into the C2 JSDoc update — `createDebouncedAdapter`
  now documents `destroy()` semantics including pending-save rejection.
- **No CHANGELOG before this entry.** This file is new; prior alpha
  releases were tracked only in git history.
- **Public API stability.** `YjsSnapshotAdapter`, `createYjsAdapter`,
  `createDebouncedAdapter`, and `createCollabPlugin` all preserve
  their previous signatures. Two new optional fields are additive:
  `MetricsSnapshot.presenceValidationFailures` and
  `CreateCollabPluginOptions.onSaveError`.
