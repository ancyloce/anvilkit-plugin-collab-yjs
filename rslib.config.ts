import { defineConfig } from "@rslib/core";

/**
 * Bundleless build for `@anvilkit/plugin-collab-yjs`.
 *
 * Each `.ts` under `src/` becomes an individual ESM + CJS output in
 * `dist/`. Yjs and y-protocols stay external so the plugin remains a
 * thin transport-agnostic adapter; consumers install Yjs once at the
 * application root.
 */
export default defineConfig({
	source: {
		entry: {
			index: [
				"./src/**/*.ts",
				"!./src/**/*.test.ts",
				"!./src/**/*.spec.ts",
				"!./src/**/__tests__/**",
			],
		},
	},
	lib: [
		{
			bundle: false,
			dts: {
				autoExtension: true,
			},
			format: "esm",
		},
		{
			bundle: false,
			dts: {
				autoExtension: true,
			},
			format: "cjs",
		},
	],
	output: {
		target: "node",
		externals: [
			"@anvilkit/core",
			"@anvilkit/ir",
			"@anvilkit/plugin-version-history",
			"@anvilkit/utils",
			"@puckeditor/core",
			"react",
			"react-dom",
			"yjs",
			"y-protocols",
			"y-protocols/awareness",
			"y-websocket",
		],
	},
});
