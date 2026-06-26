/**
 * Report 0006 §4.1.2 — machine-checkable shared-type support contract.
 *
 * This plugin is a **PageIR-only Yjs adapter**, not a general-purpose
 * Yjs binding. It mirrors a Puck `PageIR` into a flat-addressed `Y.Map`
 * tree — one `Y.Map` per node, a per-parent `Y.Array<string>` `childIds`
 * list, and JSON-encoded prop values (see `native-tree.ts`). It does
 * NOT bind native `Y.Text`, `Y.XmlElement`, `Y.XmlFragment`, or
 * subdocuments through its public surface: rich-text/XML/subdoc CRDTs
 * are explicitly out of scope.
 *
 * The constants below pin that boundary as a public, testable contract
 * so a future change that widens (or breaks) the supported set has to
 * update this descriptor too, and so hosts can branch on the contract
 * programmatically instead of reading prose.
 */

import * as Y from "yjs";
import { DEFAULT_MAP_NAME } from "./keys.js";

/**
 * Identifiers for the Yjs shared types relevant to this adapter's
 * contract. `"Y.Doc"` denotes a Yjs **subdocument**.
 */
export type YSharedTypeName =
	| "Y.Map"
	| "Y.Array"
	| "Y.Text"
	| "Y.XmlElement"
	| "Y.XmlFragment"
	| "Y.Doc";

/** Shape of {@link SHARED_TYPE_SUPPORT}. */
export interface SharedTypeSupport {
	/**
	 * The adapter mirrors a single domain model — Puck's `PageIR` — and
	 * is not a generic Yjs↔CRDT binding. Pinned to `"page-ir"`.
	 */
	readonly model: "page-ir";
	/**
	 * Shared types the adapter reads/writes as part of the PageIR
	 * encoding: the per-node / props `Y.Map`s and the `childIds`
	 * `Y.Array`. These are the ONLY Yjs types the native tree touches.
	 */
	readonly managed: readonly YSharedTypeName[];
	/**
	 * Native collaborative types that have **no** public binding into
	 * PageIR. Concurrent edits inside these are not projected into the
	 * editor — use {@link getHostSharedRoot} to attach them to the same
	 * `Y.Doc` under a host-owned, adapter-ignored namespace.
	 */
	readonly unsupported: readonly YSharedTypeName[];
	/**
	 * How a node's `props` are stored. Each prop value is a JSON-encoded
	 * string inside the per-node `Y.Map`, so a prop is opaque to the IR
	 * contract and is never a live nested collaborative type.
	 */
	readonly propEncoding: "json-string";
}

/**
 * Public, machine-checkable descriptor of which Yjs shared types
 * `createYjsAdapter` binds. See the module doc-comment for the rationale.
 */
export const SHARED_TYPE_SUPPORT: SharedTypeSupport = {
	model: "page-ir",
	managed: ["Y.Map", "Y.Array"],
	unsupported: ["Y.Text", "Y.XmlElement", "Y.XmlFragment", "Y.Doc"],
	propEncoding: "json-string",
};

/**
 * Whether the given Yjs shared type participates in this adapter's
 * PageIR encoding. Returns `true` only for the structural containers
 * the native tree manages (`Y.Map`, `Y.Array`); every other type
 * (`Y.Text`, `Y.XmlElement`, `Y.XmlFragment`, subdocs) is out of scope.
 */
export function isManagedSharedType(name: YSharedTypeName): boolean {
	return SHARED_TYPE_SUPPORT.managed.includes(name);
}

/** Infix that namespaces a host-owned root away from every adapter key. */
const HOST_ROOT_INFIX = ":host:";

/**
 * Escape hatch for hosts that genuinely need a native shared type the
 * adapter does not bind (a `Y.Text` comment thread, a `Y.XmlFragment`
 * rich-text field, a subdoc, etc.).
 *
 * Returns a top-level `Y.Map` on the same `Y.Doc`, keyed under
 * `` `${mapName}:host:${namespace}` ``. The key is guaranteed disjoint
 * from the two roots the adapter manages — the legacy blob root
 * (`mapName`) and the native tree root (`` `${mapName}:tree` ``) — so
 * attaching arbitrary shared types here can never collide with or
 * corrupt the PageIR encoding.
 *
 * The adapter never reads or writes this map: its content does NOT
 * appear in the projected `PageIR`, is not part of snapshots, undo, or
 * conflict detection. It IS still replicated by Yjs (it lives on the
 * shared `Y.Doc`) and carried by the opt-in persistence/transport, so
 * peers converge on it — but interpreting and rendering it is entirely
 * the host's responsibility.
 *
 * @param doc       The shared `Y.Doc` (the same one passed to `createYjsAdapter`).
 * @param namespace A host-chosen, non-empty sub-key for this shared type.
 * @param mapName   The adapter's `mapName` (defaults to the adapter default).
 */
export function getHostSharedRoot(
	doc: Y.Doc,
	namespace: string,
	mapName: string = DEFAULT_MAP_NAME,
): Y.Map<unknown> {
	if (namespace.length === 0) {
		throw new Error("getHostSharedRoot: `namespace` must be non-empty.");
	}
	return doc.getMap<unknown>(`${mapName}${HOST_ROOT_INFIX}${namespace}`);
}
