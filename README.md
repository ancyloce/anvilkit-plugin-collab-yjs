# @anvilkit/plugin-collab-yjs

> **Beta channel.** This package ships under the `@beta` npm dist-tag
> through the Phase 1 cycle (v0.2.x). The legacy whole-document JSON
> encoding remains the default; per-node CRDT merge is opt-in via
> `useNativeTree: true`. See `docs/policies/lts.md` for the GA timeline.

A first-party Anvilkit Studio plugin that proves the
`SnapshotAdapter` v2 contract can host live CRDT state alongside Puck
without forking Core or Puck. Built on
[Yjs](https://github.com/yjs/yjs) and
[`y-protocols/awareness`](https://github.com/yjs/y-protocols).

## Usage

```ts
import {
  createCollabPlugin,
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
  // Phase 1 opt-in (D1): mirror PageIR as a flat Y.Map tree so disjoint
  // concurrent edits to different nodes both survive instead of LWW-
  // overwriting one another. Pick one mode per room; native-tree
  // replicas and JSON-blob replicas cannot share a Y.Doc.
  useNativeTree: true,
});

// Optional: coalesce slider drags / rapid typing into one write per
// debounce window (default 150ms).
const debounced = createDebouncedAdapter(adapter, { ms: 150 });

registerPlugins([
  createCollabPlugin({
    adapter: debounced,
    puckConfig: myPuckConfig,
    // Defense-in-depth — every transport is treated as untrusted.
    // Returning null or throwing rejects the remote update.
    validateRemoteIR: (ir) => (isWellFormed(ir) ? ir : null),
    onValidationFailure: (failure) => toast(`Rejected: ${failure.kind}`),
  }),
]);

// Phase 1 (D2): subscribe to overlap diagnostics for host UI toasts.
adapter.onConflict((event) => {
  toast(`Edit overlapped on nodes: ${event.nodeIds.join(", ")}`);
});
```

## Encoding

By default the latest live `PageIR` is JSON-encoded under a single
`Y.Map` key (`pageIR`). Yjs gives last-writer-wins semantics for the
live document with deterministic conflict resolution — correct, but
coarse-grained: concurrent edits to different nodes can overwrite
each other.

Setting `useNativeTree: true` replaces the JSON blob with a flat-
addressed `Y.Map` mirror of the IR (one `Y.Map` per node, plus a
`childIds` `Y.Array` per parent). Concurrent edits to **different**
node ids merge cleanly. Edits to the *same* node still rely on Y.Map
prop-level LWW.

Each saved snapshot also gets its own `snapshotMeta:<id>` and
`snapshotPayload:<id>` keys so the adapter can satisfy the
`SnapshotAdapter` history contract regardless of the live encoding.

See [`docs/architecture/realtime-collab.md`](../../../docs/architecture/realtime-collab.md)
for the full design and threat model.

## Reference transport

A minimal `y-websocket` relay lives under `examples/` in this
repository. The examples directory is source-only and is not included
in the published npm package:

```bash
node packages/plugins/plugin-collab-yjs/examples/y-websocket-server.mjs
```

A production-grade `hocuspocus` recipe (auth, persistence, scale-out)
ships in Phase 2 (GA Core).
