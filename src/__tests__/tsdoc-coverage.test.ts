import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards TSDoc coverage on the package's PUBLIC implementation FUNCTIONS
 * (Report 0006 §4.3.2).
 *
 * Every exported FUNCTION re-exported from `src/index.ts` (plus the
 * `createManagedTransport` factory exposed via the documented
 * `./transport` entry) must carry a `/** ... *\/` TSDoc block immediately
 * above its `export function <name>` declaration. Readable names alone
 * are not a substitute for an intent/param/return contract on the public
 * surface, and this test fails if any of these functions loses its doc
 * block.
 *
 * The check is intentionally AST-lite: it reads each source file with
 * Node `fs`, locates the `export function <name>` (or `export const
 * <name> =`) declaration, walks back over blank lines, and asserts the
 * immediately-preceding token is the `*\/` of a `/**` (not a bare `/*`)
 * block.
 */

/** name -> source file (relative to this test file) that declares it. */
const PUBLIC_FUNCTIONS: Record<string, string> = {
	// src/index.ts re-exports
	createCollabDataPlugin: "../plugin.ts",
	createCollabPlugin: "../plugin.ts",
	createDebouncedAdapter: "../utils/debounced-adapter.ts",
	diffSnapshots: "../utils/diff.ts",
	encodeIR: "../utils/encode.ts",
	decodeIR: "../utils/encode.ts",
	hashIR: "../utils/encode.ts",
	sanitizeDisplayName: "../utils/presence-schema.ts",
	sanitizePresenceSelection: "../utils/presence-schema.ts",
	validatePeerInfo: "../utils/presence-schema.ts",
	validatePresenceActivity: "../utils/presence-schema.ts",
	validatePresenceCursor: "../utils/presence-schema.ts",
	validatePresenceSelection: "../utils/presence-schema.ts",
	validatePresenceState: "../utils/presence-schema.ts",
	validatePresenceViewport: "../utils/presence-schema.ts",
	usePuckMultiSelection: "../utils/selection-bridge.ts",
	usePuckSelection: "../utils/selection-bridge.ts",
	getHostSharedRoot: "../utils/shared-types.ts",
	isManagedSharedType: "../utils/shared-types.ts",
	createYjsAdapter: "../utils/yjs-adapter.ts",
	// public `./transport` entry
	createManagedTransport: "../transport.ts",
};

function readSource(relPath: string): string {
	return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

/**
 * Returns a TSDoc-presence verdict for `name` within `source`: whether a
 * `/** ... *\/` block immediately precedes the `export function <name>`
 * (or `export const <name> =`) declaration.
 */
function tsDocVerdict(
	source: string,
	name: string,
): { ok: boolean; reason: string } {
	const lines = source.split("\n");
	const declRe = new RegExp(
		`^export (async )?function ${name}\\b|^export const ${name}\\b\\s*=`,
	);
	const declIdx = lines.findIndex((line) => declRe.test(line));
	if (declIdx < 0) {
		return { ok: false, reason: `declaration for "${name}" not found` };
	}

	// Walk back over blank lines to the immediately-preceding token.
	let i = declIdx - 1;
	while (i >= 0 && lines[i].trim() === "") i--;
	if (i < 0) {
		return { ok: false, reason: `"${name}": no preceding line` };
	}
	if (lines[i].trim() !== "*/") {
		return {
			ok: false,
			reason: `"${name}": expected a TSDoc block, prev line is [${lines[i].trim()}]`,
		};
	}

	// Walk back to the comment opener; it must be `/**` (TSDoc), not `/*`.
	let j = i - 1;
	while (j >= 0) {
		const trimmed = lines[j].trim();
		if (trimmed.startsWith("/**")) return { ok: true, reason: "ok" };
		if (trimmed.startsWith("/*")) {
			return {
				ok: false,
				reason: `"${name}": comment block is a plain /* block, not /** TSDoc`,
			};
		}
		j--;
	}
	return { ok: false, reason: `"${name}": no /** opener found above */` };
}

describe("public function TSDoc coverage (Report 0006 §4.3.2)", () => {
	for (const [name, relPath] of Object.entries(PUBLIC_FUNCTIONS)) {
		it(`documents ${name}`, () => {
			const verdict = tsDocVerdict(readSource(relPath), name);
			expect(verdict.ok, verdict.reason).toBe(true);
		});
	}
});
