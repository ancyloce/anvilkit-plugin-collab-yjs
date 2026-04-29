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
			name: "@anvilkit/plugin-collab-yjs",
			passWithNoTests: true,
		},
	}),
);
