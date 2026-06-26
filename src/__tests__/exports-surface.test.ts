import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the package's PUBLIC export surface (Report 0006 §4.2.6).
 *
 * The `package.json` `exports` map must expose ONLY the two documented
 * entry points — the root barrel (`.`) and the secondary transport entry
 * (`./transport`). A wildcard `"./*"` subpath would turn every internal
 * module into a public entry point, so a refactor of any internal file
 * becomes a breaking change. This test fails if the wildcard (or any
 * other undocumented subpath) leaks back into the exports map.
 */
const pkg = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("../../package.json", import.meta.url)),
		"utf8",
	),
) as { exports: Record<string, unknown> };

describe("package exports surface", () => {
	const exportKeys = Object.keys(pkg.exports);

	it("exposes exactly the documented public entry points", () => {
		expect(new Set(exportKeys)).toEqual(new Set([".", "./transport"]));
	});

	it("does not expose a wildcard subpath", () => {
		expect(exportKeys).not.toContain("./*");
	});

	it("keeps the root barrel entry", () => {
		expect(exportKeys).toContain(".");
	});

	it("keeps the documented transport entry", () => {
		expect(exportKeys).toContain("./transport");
	});
});
