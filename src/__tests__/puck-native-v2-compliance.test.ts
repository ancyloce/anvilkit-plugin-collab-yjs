/**
 * @file PLAN-0025 Phase 3.5 (P3.5-05) — per-node appearance merge
 * revalidation on Puck-native v2 documents.
 *
 * The plan's §16 risk row asks whether per-node `appearance` props
 * change collab merge granularity. Grounded answer, pinned here: with
 * the alpha JSON-blob encoding (one Y.Map key per document), ALL
 * concurrent writes are LWW on the whole PageIR — appearance props
 * neither tighten nor loosen granularity, they ride the same blob.
 * Both replicas always converge; a concurrent editor's appearance
 * edit on a DIFFERENT node can therefore be dropped by LWW exactly
 * like any other concurrent edit today. The GA plan (mirroring the IR
 * tree natively in Y) is where per-node granularity arrives; these
 * tests are the tripwire that documents the alpha semantics until
 * then.
 *
 * Also: the per-package §15-gate-3 source scan (no sidecar / sidecar
 * editor commands).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, Doc as YDoc } from "yjs";
import { createYjsAdapter } from "../utils/yjs-adapter.js";

const FORBIDDEN = [
	"__anvilkit",
	"readAuthoringState",
	"writeAuthoringState",
	"ANVILKIT_AUTHORING_KEY",
	"EditorCommandPort",
	"applyEditorCommand",
	'"replaceRoot"',
] as const;

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			files.push(...sourceFiles(path));
			continue;
		}
		if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
	}
	return files;
}

function pair(a: YDoc, b: YDoc): void {
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(b, update, "replicate");
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== "replicate") applyUpdate(a, update, "replicate");
	});
}

function appearanceOf(display: string) {
	return {
		version: "1",
		targets: { root: { style: { base: { layout: { display } } } } },
	};
}

/** A two-node v2 document with per-node appearance carriers. */
function v2PageIR(heroDisplay: string, buttonDisplay: string): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [
				{
					id: "hero-1",
					type: "Hero",
					props: {
						title: "Hello",
						appearance: appearanceOf(heroDisplay),
						interactions: [{ id: "i-1", trigger: "click" }],
					},
				},
				{
					id: "btn-1",
					type: "Button",
					props: {
						label: "Go",
						appearance: appearanceOf(buttonDisplay),
						bindings: [{ id: "b-1", nodeId: "btn-1" }],
					},
				},
			],
		},
	} as PageIR;
}

function heroAppearance(ir: PageIR): unknown {
	const children = (
		ir as unknown as {
			root: { children: { id: string; props: Record<string, unknown> }[] };
		}
	).root.children;
	return children.find((child) => child.id === "hero-1")?.props.appearance;
}

describe("Puck-native v2 compliance (P3.5-05)", () => {
	it("no source file references the sidecar or sidecar editor commands", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(join(__dirname, ".."))) {
			const source = readFileSync(file, "utf8");
			for (const marker of FORBIDDEN) {
				if (source.includes(marker)) offenders.push(`${file}: ${marker}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("a single writer's v2 carriers replicate byte-identically", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);
		const alpha = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const beta = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		alpha.save(v2PageIR("flex", "block"), {});

		const replicated = beta.list();
		expect(replicated.length).toBeGreaterThan(0);
		const lastId = replicated[replicated.length - 1]?.id as string;
		const ir = beta.load(lastId);
		expect(heroAppearance(ir)).toEqual(appearanceOf("flex"));
	});

	it("concurrent appearance edits on DIFFERENT nodes converge via whole-document LWW (pinned alpha semantics)", () => {
		const docA = new YDoc();
		const docB = new YDoc();
		pair(docA, docB);
		const alpha = createYjsAdapter({ doc: docA, peer: { id: "alice" } });
		const beta = createYjsAdapter({ doc: docB, peer: { id: "bob" } });

		// Same starting point on both sides…
		alpha.save(v2PageIR("flex", "block"), {});
		// …then diverge: alpha styles the hero, beta styles the button.
		alpha.save(v2PageIR("grid", "block"), {});
		beta.save(v2PageIR("flex", "inline-flex"), {});

		const finalAlpha = alpha.list();
		const finalBeta = beta.list();
		// CRDT convergence: both replicas agree…
		expect(finalAlpha).toEqual(finalBeta);
		const winnerId = finalAlpha[finalAlpha.length - 1]?.id as string;
		const irAlpha = alpha.load(winnerId);
		const irBeta = beta.load(winnerId);
		expect(irAlpha).toEqual(irBeta);
		// …on exactly ONE of the two writes: whole-blob LWW. Per-node
		// appearance does NOT merge in the alpha encoding — a concurrent
		// editor's styling of a DIFFERENT node can be dropped, exactly
		// like any other concurrent edit today. The GA tree mirror is
		// where per-node granularity arrives; this pin is its tripwire.
		const converged = JSON.stringify(irAlpha);
		const alphaWon = converged.includes('"grid"');
		const betaWon = converged.includes('"inline-flex"');
		expect(alphaWon !== betaWon).toBe(true);
	});
});
