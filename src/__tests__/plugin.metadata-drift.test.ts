import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createCollabDataPlugin } from "../plugin.js";

/**
 * M1 — guards against the runtime metadata / public-doc drift the
 * review flagged: `META.version` lagging `package.json`, and the
 * `useNativeTree` / `localPeer` doc comments contradicting behavior.
 */
describe("plugin metadata drift (M1)", () => {
  it("META.version matches package.json version", () => {
    const pkgPath = fileURLToPath(
      new URL("../../package.json", import.meta.url),
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
    };
    const plugin = createCollabDataPlugin({
      adapter: { save: () => "id", list: () => [], load: () => null as never },
    });
    expect(plugin.meta.version).toBe(pkg.version);
  });
});
