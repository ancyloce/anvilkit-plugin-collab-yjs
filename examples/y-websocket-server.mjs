#!/usr/bin/env node
// Minimal y-websocket relay used by integration tests and the demo
// app. Production deployments should replace this with a managed
// transport (yjs-redis, hocuspocus, custom) — this is alpha-grade.
//
// Run: node examples/y-websocket-server.mjs [port]
import { createServer } from "node:http";
import { setupWSConnection } from "y-websocket/bin/utils";
import { WebSocketServer } from "ws";

const port = Number.parseInt(process.argv[2] ?? "1234", 10);

const httpServer = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("anvilkit y-websocket reference relay\n");
});

const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (conn, req) => setupWSConnection(conn, req));

httpServer.listen(port, () => {
	console.log(`y-websocket relay listening on ws://localhost:${port}`);
});
