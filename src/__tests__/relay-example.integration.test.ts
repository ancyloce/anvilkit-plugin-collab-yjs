import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("reference y-websocket relay", () => {
	it("starts from the documented example entrypoint", async () => {
		const serverPath = fileURLToPath(
			new URL("../../examples/y-websocket-server.mjs", import.meta.url),
		);
		const child = spawn(process.execPath, [serverPath, "0"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		const started = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(
					new Error(
						`relay did not start in time. stdout=${stdout} stderr=${stderr}`,
					),
				);
			}, 5_000);

			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				if (stdout.includes("y-websocket relay listening")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("exit", (code) => {
				clearTimeout(timeout);
				reject(
					new Error(
						`relay exited before listening. code=${code} stdout=${stdout} stderr=${stderr}`,
					),
				);
			});
		});

		try {
			await started;
			expect(stdout).toContain("y-websocket relay listening");
		} finally {
			const exited = once(child, "exit").catch(() => undefined);
			child.kill();
			await exited;
		}
	});
});
