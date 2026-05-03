# @anvilkit/plugin-collab-yjs

> **Alpha channel only.** This package ships under the `@alpha` npm
> dist-tag through the `v1.1` cycle. It is not covered by the
> `v1.0` LTS commitment. See `docs/policies/lts.md`.

A first-party Anvilkit Studio plugin that proves the
`SnapshotAdapter` v2 contract can host live CRDT state alongside Puck
without forking Core or Puck. Built on
[Yjs](https://github.com/yjs/yjs) and
[`y-protocols/awareness`](https://github.com/yjs/y-protocols).

## Usage

```ts
import { createCollabPlugin, createYjsAdapter } from "@anvilkit/plugin-collab-yjs";
import { Doc as YDoc } from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new YDoc();
const provider = new WebsocketProvider("ws://localhost:1234", "demo-room", doc);

const adapter = createYjsAdapter({
  doc,
  awareness: provider.awareness,
  peer: { id: "alice", displayName: "Alice", color: "#f43f5e" },
});

registerPlugins([
  createCollabPlugin({ adapter, puckConfig: myPuckConfig }),
]);
```

## Encoding (alpha)

The latest live `PageIR` is JSON-encoded and stored under a single
Y.Map key. Each saved snapshot also gets its own metadata + payload
keys so the adapter can satisfy the `SnapshotAdapter` history
contract. Yjs gives last-writer-wins semantics for the live document
with deterministic conflict resolution — correct, but coarse-grained. See
[`docs/architecture/realtime-collab.md`](../../../docs/architecture/realtime-collab.md)
for the alpha trade-offs and the GA plan to mirror the IR tree
natively into Yjs structures.

## Reference transport

A minimal `y-websocket` relay lives under `examples/` in this
repository. The examples directory is source-only and is not included
in the published npm package:

```bash
node packages/plugins/plugin-collab-yjs/examples/y-websocket-server.mjs
```
