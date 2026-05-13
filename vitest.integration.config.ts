import { defineConfig } from "vitest/config";

/**
 * Opt-in integration suite (L4). Tests under `*.integration.test.ts`
 * spawn subprocesses or hit real transports and are too flaky / slow
 * for the default unit suite. Run with `pnpm test:integration`.
 */
export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		clearMocks: true,
		restoreMocks: true,
		include: ["src/**/*.integration.{test,spec}.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		name: "@anvilkit/plugin-collab-yjs:integration",
		passWithNoTests: true,
		testTimeout: 30_000,
	},
});
