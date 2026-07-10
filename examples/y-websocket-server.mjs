#!/usr/bin/env node
// Minimal y-websocket relay used by integration tests and the demo
// app. Production deployments should replace this with a managed
// transport (yjs-redis, hocuspocus, custom) — this is alpha-grade.
//
// Run: node examples/y-websocket-server.mjs [port]
//
// y-websocket@3 dropped the bundled server (`y-websocket/bin/utils`), and
// `@y/websocket-server` is the incompatible yjs-14 line. So this relay
// vendors the classic y-protocols sync/awareness server inline against our
// yjs-13 stack — wire-compatible with the demo's y-websocket@3 client and
// independent of y-websocket's server packaging.
import { createServer } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as map from "lib0/map";
import { WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

// ── Inline reference server (adapted from y-websocket@1 `bin/utils`) ──────
const messageSync = 0;
const messageAwareness = 1;
const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const pingTimeout = 30_000;

/** docName → shared doc. One Y.Doc + Awareness per room, shared by conns. */
const docs = new Map();

class WSSharedDoc extends Y.Doc {
	constructor(name) {
		super({ gc: true });
		this.name = name;
		/** conn → set of awareness clientIDs it controls. */
		this.conns = new Map();
		this.awareness = new awarenessProtocol.Awareness(this);
		this.awareness.setLocalState(null);

		this.awareness.on("update", ({ added, updated, removed }, origin) => {
			const changedClients = added.concat(updated, removed);
			const controlled = origin !== null ? this.conns.get(origin) : undefined;
			if (controlled !== undefined) {
				for (const id of added) controlled.add(id);
				for (const id of removed) controlled.delete(id);
			}
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
			);
			const buf = encoding.toUint8Array(encoder);
			for (const conn of this.conns.keys()) send(this, conn, buf);
		});

		this.on("update", (update) => {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageSync);
			syncProtocol.writeUpdate(encoder, update);
			const buf = encoding.toUint8Array(encoder);
			for (const conn of this.conns.keys()) send(this, conn, buf);
		});
	}
}

function getYDoc(docName) {
	return map.setIfUndefined(docs, docName, () => {
		const doc = new WSSharedDoc(docName);
		docs.set(docName, doc);
		return doc;
	});
}

function send(doc, conn, message) {
	if (
		conn.readyState !== wsReadyStateConnecting &&
		conn.readyState !== wsReadyStateOpen
	) {
		closeConn(doc, conn);
		return;
	}
	try {
		conn.send(message, (err) => err != null && closeConn(doc, conn));
	} catch {
		closeConn(doc, conn);
	}
}

function closeConn(doc, conn) {
	const controlled = doc.conns.get(conn);
	if (controlled !== undefined) {
		doc.conns.delete(conn);
		awarenessProtocol.removeAwarenessStates(
			doc.awareness,
			Array.from(controlled),
			null,
		);
		if (doc.conns.size === 0) {
			doc.destroy();
			docs.delete(doc.name);
		}
	}
	conn.close();
}

function messageListener(conn, doc, message) {
	try {
		const encoder = encoding.createEncoder();
		const decoder = decoding.createDecoder(message);
		const messageType = decoding.readVarUint(decoder);
		switch (messageType) {
			case messageSync:
				encoding.writeVarUint(encoder, messageSync);
				// `conn` is the transaction origin so our own `update` handler
				// won't echo the message straight back to the sender.
				syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
				// Reply only if readSyncMessage wrote a response (length > 1).
				if (encoding.length(encoder) > 1) {
					send(doc, conn, encoding.toUint8Array(encoder));
				}
				break;
			case messageAwareness:
				awarenessProtocol.applyAwarenessUpdate(
					doc.awareness,
					decoding.readVarUint8Array(decoder),
					conn,
				);
				break;
			default:
				break;
		}
	} catch (err) {
		console.error("[y-websocket-server] message handling error:", err);
	}
}

/** Wire a single ws connection into the shared doc for its room. */
function setupWSConnection(conn, req) {
	conn.binaryType = "arraybuffer";
	// The client dials `ws://host:port/<room>`, so the room is the path.
	const docName = (req.url ?? "/").slice(1).split("?")[0] || "default";
	const doc = getYDoc(docName);
	doc.conns.set(conn, new Set());

	conn.on("message", (data) =>
		messageListener(conn, doc, new Uint8Array(data)),
	);

	// Keepalive: drop a connection that misses a pong.
	let pongReceived = true;
	const pingInterval = setInterval(() => {
		if (!pongReceived) {
			if (doc.conns.has(conn)) closeConn(doc, conn);
			clearInterval(pingInterval);
		} else if (doc.conns.has(conn)) {
			pongReceived = false;
			try {
				conn.ping();
			} catch {
				closeConn(doc, conn);
				clearInterval(pingInterval);
			}
		}
	}, pingTimeout);
	conn.on("pong", () => {
		pongReceived = true;
	});
	conn.on("close", () => {
		closeConn(doc, conn);
		clearInterval(pingInterval);
	});

	// Initial handshake: sync step 1 + the current awareness snapshot.
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, messageSync);
	syncProtocol.writeSyncStep1(encoder, doc);
	send(doc, conn, encoding.toUint8Array(encoder));

	const states = doc.awareness.getStates();
	if (states.size > 0) {
		const aEncoder = encoding.createEncoder();
		encoding.writeVarUint(aEncoder, messageAwareness);
		encoding.writeVarUint8Array(
			aEncoder,
			awarenessProtocol.encodeAwarenessUpdate(
				doc.awareness,
				Array.from(states.keys()),
			),
		);
		send(doc, conn, encoding.toUint8Array(aEncoder));
	}
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────
// Default 21234 matches `apps/studio/scripts/dev-collab.mjs` and
// `apps/studio/playwright.config.ts`. 1234 and 11234 are commonly
// excluded by Hyper-V dynamic port reservations under WSL2, surfacing
// as a misleading EADDRINUSE even when `/proc/net/tcp*` is empty.
const port = Number.parseInt(process.argv[2] ?? "21234", 10);
// Bind to the loopback by default. The relay is local-only (the demo
// + tests connect via `ws://localhost:<port>`) and binding `::`
// /`0.0.0.0` collides with Windows-host port reservations under WSL2
// (Hyper-V dynamic exclusion ranges), surfacing as a misleading
// EADDRINUSE even when `/proc/net/tcp*` is empty. Override via
// `COLLAB_RELAY_HOST` if a non-loopback bind is genuinely needed.
const host = process.env.COLLAB_RELAY_HOST ?? "127.0.0.1";

const httpServer = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("anvilkit y-websocket reference relay\n");
});

const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (conn, req) => setupWSConnection(conn, req));

// Surface EADDRINUSE as an actionable single-line failure instead of an
// unhandled-error stack. `dev-collab.mjs` reaps stale relays before
// spawning us, but a relay started outside that supervisor (manual run,
// Playwright fixture, etc.) can still be holding the port. `ws`
// re-emits `error` from its underlying http server, so we attach to
// both — one drives the user-facing exit, the other is a no-op to
// keep the second emission from becoming an unhandled `error` event.
function handleListenError(err) {
	if (err && err.code === "EADDRINUSE") {
		console.error(
			`[y-websocket-server] port ${port} already in use. ` +
				`Kill the stale relay (e.g. \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` then \`kill <pid>\`) ` +
				`or override with COLLAB_RELAY_PORT=<other-port>.`,
		);
	} else {
		console.error(`[y-websocket-server] ${err?.message ?? err}`);
	}
	process.exit(1);
}
httpServer.on("error", handleListenError);
// Swallow the re-emit; `handleListenError` has already exited.
wss.on("error", () => {});

httpServer.listen(port, host, () => {
	const shownHost = host === "127.0.0.1" || host === "::1" ? "localhost" : host;
	console.log(`y-websocket relay listening on ws://${shownHost}:${port}`);
});
