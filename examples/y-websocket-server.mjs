#!/usr/bin/env node
// Minimal y-websocket relay used by integration tests and the demo
// app. Production deployments should replace this with a managed
// transport (yjs-redis, hocuspocus, custom) — this is alpha-grade.
//
// Run: node examples/y-websocket-server.mjs [port]
import { createServer } from "node:http";
import { setupWSConnection } from "y-websocket/bin/utils";
import { WebSocketServer } from "ws";

// Default 21234 matches `apps/demo/scripts/dev-collab.mjs` and
// `apps/demo/playwright.config.ts`. 1234 and 11234 are commonly
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
