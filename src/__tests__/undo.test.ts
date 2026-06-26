/**
 * @file §4.1.1 — local undo/redo regression coverage.
 *
 * Pins the opt-in `Y.UndoManager` integration exposed by
 * `createYjsAdapter` when `options.undo` is provided:
 *
 *   1. Local saves are captured; `undo()` rewinds the live PageIR to
 *      the previous edit and `redo()` re-applies it (canUndo/canRedo
 *      track the stacks).
 *   2. Remote-origin changes (a different peer / transport applyUpdate)
 *      are NOT tracked, so `undo()` can never roll back another
 *      collaborator's work. This guards the `trackedOrigins` filter —
 *      Yjs's default tracked set includes `null`, which is the origin a
 *      bare `applyUpdate` uses, so the adapter must override it.
 *   3. `destroy()` releases the UndoManager's `afterTransaction`
 *      handler (no doc-listener leak) and stops stack-change
 *      notifications.
 */

import { createFakePageIR } from "@anvilkit/core/testing";
import type { PageIR } from "@anvilkit/core/types";
import { describe, expect, it } from "vitest";
import { applyUpdate, encodeStateAsUpdate, Doc as YDoc } from "yjs";

import { createYjsAdapter } from "../utils/yjs-adapter.js";

function withHeadline(headline: string): PageIR {
	const ir = createFakePageIR();
	return {
		...ir,
		root: {
			...ir.root,
			children: [{ id: "hero-1", type: "Hero", props: { headline } }],
		},
	};
}

function afterTransactionListeners(doc: YDoc): number {
	const observers = (
		doc as unknown as { _observers: Map<string, Set<unknown>> }
	)._observers;
	return observers.get("afterTransaction")?.size ?? 0;
}

describe("createYjsAdapter undo/redo (§4.1.1)", () => {
	it("captures local saves and undo()/redo() walk the live PageIR", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({
			doc,
			peer: { id: "local" },
			// Every save is its own undo boundary so the two edits below
			// do not merge into one stack item.
			undo: { captureTimeout: 0 },
		});
		// Undo applies with the UndoManager as the transaction origin, so
		// the adapter re-emits the rewound document through `subscribe`
		// exactly like any other non-local change.
		const emitted: PageIR[] = [];
		adapter.subscribe((ir) => emitted.push(ir));

		expect(adapter.canUndo()).toBe(false);
		expect(adapter.canRedo()).toBe(false);

		adapter.save(withHeadline("v1"), {});
		adapter.save(withHeadline("v2"), {});

		expect(adapter.canUndo()).toBe(true);
		expect(adapter.canRedo()).toBe(false);

		adapter.undo();
		expect(adapter.canRedo()).toBe(true);
		expect(emitted.at(-1)?.root.children?.[0]?.props.headline).toBe("v1");

		adapter.redo();
		expect(emitted.at(-1)?.root.children?.[0]?.props.headline).toBe("v2");

		adapter.destroy();
	});

	it("does not track remote-origin changes, so undo() cannot roll them back", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({
			doc,
			peer: { id: "local" },
			undo: { captureTimeout: 0 },
		});

		// A remote peer authors a change in its own doc; we merge its
		// update with a bare applyUpdate (origin defaults to `null`).
		const remoteDoc = new YDoc();
		const remoteAdapter = createYjsAdapter({
			doc: remoteDoc,
			peer: { id: "remote" },
		});
		remoteAdapter.save(withHeadline("from-remote"), {});
		applyUpdate(doc, encodeStateAsUpdate(remoteDoc));

		// The remote write reached our replica but is NOT on the local
		// undo stack. (With Yjs's default `trackedOrigins` of `[null]`
		// this would be `true` — that is the regression this pins.)
		expect(adapter.canUndo()).toBe(false);

		const emitted: PageIR[] = [];
		adapter.subscribe((ir) => emitted.push(ir));
		adapter.undo();
		expect(emitted).toHaveLength(0);

		remoteAdapter.destroy();
		adapter.destroy();
	});

	it("destroy() releases the UndoManager and stops stack-change notifications", () => {
		const doc = new YDoc();
		const baseline = afterTransactionListeners(doc);

		const adapter = createYjsAdapter({
			doc,
			peer: { id: "local" },
			undo: { captureTimeout: 0 },
		});
		// The UndoManager registers exactly one doc-level afterTransaction
		// handler.
		expect(afterTransactionListeners(doc)).toBe(baseline + 1);

		let stackChanges = 0;
		const unsubscribe = adapter.onUndoStackChange(() => {
			stackChanges += 1;
		});
		adapter.save(withHeadline("v1"), {});
		expect(stackChanges).toBe(1);

		// Unsubscribe stops further notifications.
		unsubscribe();
		adapter.save(withHeadline("v2"), {});
		expect(stackChanges).toBe(1);

		adapter.destroy();
		// No leaked afterTransaction handler.
		expect(afterTransactionListeners(doc)).toBe(baseline);
	});

	it("controller methods are inert when the undo option is omitted", () => {
		const doc = new YDoc();
		const adapter = createYjsAdapter({ doc, peer: { id: "local" } });

		adapter.save(withHeadline("v1"), {});
		expect(adapter.canUndo()).toBe(false);
		expect(adapter.canRedo()).toBe(false);
		// No-ops that must not throw.
		expect(() => {
			adapter.undo();
			adapter.redo();
			adapter.clearUndo();
		}).not.toThrow();

		adapter.destroy();
	});
});
