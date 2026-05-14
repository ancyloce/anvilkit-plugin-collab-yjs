# Hocuspocus deployment recipe

> Production-grade transport for `@anvilkit/plugin-collab-yjs`. The
> [`y-websocket-server.mjs`](../examples/y-websocket-server.mjs)
> example under `examples/` is great for local development, but it
> has no auth, no durable persistence, and no horizontal scale-out.
> When you ship a real product on top of `@anvilkit/plugin-collab-yjs`,
> run [Hocuspocus](https://tiptap.dev/hocuspocus) as the relay.

## What you get

- **Auth.** Reject websocket upgrades that can't present a valid token,
  rotate access by document, and refuse stale tokens.
- **Persistence.** Snapshot the Y.Doc to Postgres (or another database)
  on disconnect / interval so a server restart doesn't lose unflushed
  edits. Pairs cleanly with the L5 `persistence` option for client-side
  durability.
- **Horizontal scale.** Use the Redis extension to fan out Y.Doc
  updates across multiple Hocuspocus instances so an L4 load balancer
  can shard websocket connections.
- **Awareness.** Forward `awareness` updates to every peer in the
  same document and clean up on disconnect.

## Install

```bash
npm install \
  @hocuspocus/server \
  @hocuspocus/extension-database \
  @hocuspocus/extension-redis \
  yjs \
  ws
```

For the database backend pick one driver — these examples use
`postgres-js`:

```bash
npm install postgres
```

## Server

`server.mjs`:

```js
import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { Redis } from "@hocuspocus/extension-redis";
import postgres from "postgres";
import { applyUpdate, encodeStateAsUpdate, Doc as YDoc } from "yjs";

const sql = postgres(process.env.POSTGRES_URL);
const redisUrl = new URL(process.env.REDIS_URL);

const server = Server.configure({
  port: Number(process.env.PORT ?? 1234),
  name: "anvilkit-collab",

  extensions: [
    new Database({
      // Pull the persisted snapshot when a doc opens.
      fetch: async ({ documentName }) => {
        const [row] = await sql`
          select state from collab_docs where id = ${documentName} limit 1
        `;
        if (!row) return null;
        return row.state; // Uint8Array
      },

      // Persist the Y.Doc state on disconnect / interval. Hocuspocus
      // throttles this for you.
      store: async ({ documentName, state }) => {
        await sql`
          insert into collab_docs (id, state, updated_at)
          values (${documentName}, ${state}, now())
          on conflict (id) do update set
            state = excluded.state,
            updated_at = excluded.updated_at
        `;
      },
    }),

    // Fan out updates across N Hocuspocus instances. The L4 load
    // balancer can round-robin clients without breaking
    // collaboration — the Redis bus syncs document state under the
    // hood.
    new Redis({
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      ...(redisUrl.password ? { password: redisUrl.password } : {}),
    }),
  ],

  // Auth — reject connections without a valid token. Hosts pass the
  // token via the `connect()` options on the client (see below).
  async onAuthenticate({ token, documentName }) {
    if (!token) throw new Error("missing token");

    // Replace with your verification (JWT.verify, OAuth introspection,
    // etc.). Throwing here closes the websocket with a 401-equivalent
    // close code.
    const session = await verifyAndScope(token, documentName);
    if (!session) throw new Error("forbidden");

    // The returned context is attached to the connection and shows up
    // in subsequent hooks (onChange, onStateless, etc.) so you can
    // authorize specific operations.
    return { userId: session.userId, role: session.role };
  },

  // Optional defense-in-depth — reject Y.Doc updates that contain
  // structurally invalid IR (e.g. wrong PageIR.version). The
  // plugin-side `validateRemoteIR` handles per-client validation;
  // server-side validation closes the loop against malicious peers
  // who bypass the client.
  async onChange({ documentName, context, update }) {
    // Optional: log, metrics, audit. Throw to reject the update.
  },
});

server.listen();
```

## Client wiring

Plugin-side, swap the demo `y-websocket` transport for Hocuspocus's
official client provider:

```bash
npm install @hocuspocus/provider
```

```ts
import {
  createCollabDataPlugin,
  createYjsAdapter,
} from "@anvilkit/plugin-collab-yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Doc as YDoc } from "yjs";

const doc = new YDoc();
const provider = new HocuspocusProvider({
  url: "wss://collab.example.com",
  name: "demo-room",          // becomes Hocuspocus's `documentName`
  document: doc,
  token: await getAccessToken(), // verified by `onAuthenticate`
});

// Map Hocuspocus connection lifecycle into the adapter's normalized
// ConnectionStatus surface so hosts can render a unified sync indicator.
const adapter = createYjsAdapter({
  doc,
  awareness: provider.awareness,
  peer: { id: currentUser.id, displayName: currentUser.name },
  // L5 — pair the server-side Database extension with client-side
  // IndexedDB so a brief disconnect doesn't lose unflushed edits.
  persistence: {
    indexedDb: true,
    broadcastChannel: true,
    dbName: `anvilkit-collab-${currentUser.workspace}`,
  },
  connectionSource: (emit) => {
    const onStatus = ({ status }: { status: string }) => {
      switch (status) {
        case "connecting":
          emit({ kind: "connecting" });
          break;
        case "connected":
          emit({ kind: "synced", since: new Date().toISOString() });
          break;
        case "disconnected":
          emit({
            kind: "offline",
            since: new Date().toISOString(),
            queuedEdits: 0, // adapter substitutes the real count
          });
          break;
      }
    };
    provider.on("status", onStatus);
    return () => provider.off("status", onStatus);
  },
});

registerPlugins([
  createCollabDataPlugin({
    adapter,
    localPeer: { id: currentUser.id, displayName: currentUser.name },
    onSaveError: (error) => toast(`Save failed: ${error}`),
  }),
]);
```

## Schema

Minimal Postgres table:

```sql
create table collab_docs (
  id          text primary key,
  state       bytea not null,
  updated_at  timestamptz not null default now()
);
create index collab_docs_updated_at on collab_docs(updated_at);
```

Bump retention by tombstoning rows that haven't been touched in N days
if cost matters. The L5 client-side IDB queue is a sufficient safety
net for short retention windows.

## Operational notes

- **Backups.** Snapshot `collab_docs` like any other Postgres table.
  The state column is a self-contained Y.Doc encoding — restoring it
  is equivalent to `applyUpdate(new YDoc(), state)`.
- **Compaction.** Hocuspocus's `Database` extension stores the
  current state, not the update stream, so no compaction is needed
  server-side. Client-side, L5's IDB queue should periodically
  compact via `Y.mergeUpdatesV2` (a future enhancement — currently
  the queue accumulates updates until reconnect drains them).
- **Awareness.** Hocuspocus relays awareness across the bus
  automatically — no extra wiring beyond `provider.awareness` on the
  client.
- **Presence security.** Server-side trust does NOT replace the
  plugin's `validatePresenceState` / `sanitizeDisplayName`. Treat
  every awareness payload as untrusted at the rendering boundary
  even when the websocket is mutually authenticated.

## Migrating from the y-websocket example

If you're upgrading from
`examples/y-websocket-server.mjs`:

1. Stand up Hocuspocus alongside the existing y-websocket server.
2. Point a subset of clients at the new URL via a config flag.
3. The first connect for each document pulls the seed state via the
   `Database.fetch` hook — wire it to read from whatever store the
   y-websocket setup used (Postgres, file system, etc.) so existing
   documents migrate transparently.
4. Once traffic has shifted, tear down y-websocket. No client-side
   change is required beyond the provider URL.
