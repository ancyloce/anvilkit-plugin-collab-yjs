import { nodePreset } from "@anvilkit/vitest-config/node";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
	nodePreset,
	defineConfig({
		test: {
			include: [
				"src/**/*.{test,spec}.ts",
				"src/**/__tests__/**/*.{test,spec}.ts",
			],
			// Integration tests (subprocess spawns, real transport) are
			// opted in via `pnpm test:integration` so the default unit
			// suite stays fast and CI-friendly. Subprocess timeouts on
			// slow runners were a recurring flake source (L4).
			exclude: [
				"**/node_modules/**",
				"**/dist/**",
				"**/*.integration.{test,spec}.ts",
			],
			name: "@anvilkit/plugin-collab-yjs",
			passWithNoTests: true,
		},
	}),
);
