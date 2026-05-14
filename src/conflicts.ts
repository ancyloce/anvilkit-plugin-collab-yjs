import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import type { PeerInfo, Unsubscribe } from "@anvilkit/plugin-version-history";

import type { ConflictEvent } from "./types.js";

export interface ConflictModule {
	onConflict(callback: (event: ConflictEvent) => void): Unsubscribe;
	noteLocalSave(ir: PageIR): void;
	maybeFire(remoteIR: PageIR, remotePeer?: PeerInfo): void;
	closeWindow(): void;
	getLastLocalIR(): PageIR | undefined;
	setLastLocalIR(ir: PageIR): void;
	destroy(): void;
}

/**
 * Conflict-diagnostics module. Owns:
 *
 * - `lastLocalIR` — the IR snapshot taken on the most recent local
 *   save, used to compute overlap when remote updates land.
 * - `baselineIR` — the IR snapshot captured at the START of the
 *   current unconfirmed-save window (i.e. the state right before
 *   the local user's first un-acked edit). Used to distinguish
 *   props the LOCAL peer actually modified from props that simply
 *   diverge between `lastLocalIR` and the incoming remote IR.
 *   Without this anchor, two peers editing DIFFERENT props of the
 *   same node would be reported as overlapping because the merged
 *   remote node trivially differs from the local snapshot — even
 *   though the native-tree CRDT merged the disjoint edits cleanly
 *   and nothing was lost.
 * - `firstUnconfirmedLocalSaveAt` — the timestamp of the FIRST local
 *   save in the current unconfirmed window. Measured from this value
 *   (M2 fix) so a burst of local saves cannot keep extending the
 *   conflict-suppression interval indefinitely.
 * - `conflictListeners` — fan-out for `onConflict` subscribers.
 *
 * The window closes via `closeWindow()` — invoked when (a) a remote
 * update has been observed, (b) the connection-status FSM transitions
 * to `synced`, or (c) `forceResync()` runs.
 */
export function createConflicts(
	staleAfterMs: number,
	localPeer: PeerInfo,
): ConflictModule {
	const conflictListeners = new Set<(event: ConflictEvent) => void>();
	let lastLocalIR: PageIR | undefined;
	let baselineIR: PageIR | undefined;
	let firstUnconfirmedLocalSaveAt: number | undefined;

	function maybeFire(remoteIR: PageIR, remotePeer?: PeerInfo): void {
		if (conflictListeners.size === 0) return;
		if (
			firstUnconfirmedLocalSaveAt === undefined ||
			lastLocalIR === undefined
		) {
			return;
		}
		const elapsed = Date.now() - firstUnconfirmedLocalSaveAt;
		if (elapsed > staleAfterMs) return;
		const overlap = computeOverlap(baselineIR, lastLocalIR, remoteIR);
		if (overlap.length === 0) return;
		const event: ConflictEvent = {
			kind: "overlap",
			localPeer,
			remotePeer,
			nodeIds: overlap,
			at: new Date().toISOString(),
		};
		for (const listener of conflictListeners) {
			try {
				listener(event);
			} catch {
				// listener errors are swallowed; conflict reporting must
				// not poison the subscribe path.
			}
		}
	}

	return {
		onConflict(callback): Unsubscribe {
			conflictListeners.add(callback);
			return () => {
				conflictListeners.delete(callback);
			};
		},
		noteLocalSave(ir: PageIR): void {
			if (firstUnconfirmedLocalSaveAt === undefined) {
				firstUnconfirmedLocalSaveAt = Date.now();
				baselineIR = lastLocalIR;
			}
			lastLocalIR = ir;
		},
		maybeFire,
		closeWindow(): void {
			firstUnconfirmedLocalSaveAt = undefined;
			baselineIR = undefined;
		},
		getLastLocalIR(): PageIR | undefined {
			return lastLocalIR;
		},
		setLastLocalIR(ir: PageIR): void {
			lastLocalIR = ir;
		},
		destroy(): void {
			conflictListeners.clear();
		},
	};
}

/**
 * Compute the set of node ids that represent a TRUE concurrent-edit
 * conflict between the local peer and the remote peer.
 *
 * With baseline (steady-state): a node enters the overlap set only
 * when both peers modified the SAME prop with DIFFERING values, or
 * both reordered the child list to different orderings. Disjoint
 * prop edits on the same node — A typed in `headline`, B typed in
 * `description` — are NOT flagged because the native-tree CRDT
 * merged them cleanly and neither peer's work was lost.
 *
 * Without baseline (e.g. the local peer's first save in a fresh
 * session): falls back to a per-prop divergence check between local
 * and remote. This preserves the pre-baseline-tracking behavior at
 * the node level — any prop drift still flags the node — so the
 * legacy test suite that depends on conflict firing for "alice
 * saves X, bob saves Y" on a fresh doc keeps passing.
 */
function computeOverlap(
	baseline: PageIR | undefined,
	local: PageIR,
	remote: PageIR,
): readonly string[] {
	const localNodes = collectNodes(local.root);
	const remoteNodes = collectNodes(remote.root);
	const baselineNodes = baseline ? collectNodes(baseline.root) : undefined;
	const overlap: string[] = [];
	for (const [id, localNode] of localNodes) {
		const remoteNode = remoteNodes.get(id);
		if (!remoteNode) continue;
		const baselineNode = baselineNodes?.get(id);
		if (
			propsConflict(localNode.props, remoteNode.props, baselineNode?.props) ||
			childOrderConflict(
				localNode.children,
				remoteNode.children,
				baselineNode?.children,
			)
		) {
			overlap.push(id);
		}
	}
	return overlap;
}

function propsConflict(
	left: Record<string, unknown> | undefined,
	right: Record<string, unknown> | undefined,
	baseline: Record<string, unknown> | undefined,
): boolean {
	const a = left ?? {};
	const b = right ?? {};
	const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		const aRaw = JSON.stringify(a[key]);
		const bRaw = JSON.stringify(b[key]);
		if (aRaw === bRaw) continue;
		if (baseline === undefined) {
			// No baseline anchor — fall back to divergence-as-conflict
			// (preserves legacy semantics for first-save scenarios).
			return true;
		}
		const baseRaw = JSON.stringify(baseline[key]);
		// True conflict iff BOTH peers diverged from baseline on this
		// prop. If only one side moved, the CRDT merged cleanly and
		// nothing is at risk.
		if (aRaw !== baseRaw && bRaw !== baseRaw) return true;
	}
	return false;
}

function childOrderConflict(
	left: readonly PageIRNode[] | undefined,
	right: readonly PageIRNode[] | undefined,
	baseline: readonly PageIRNode[] | undefined,
): boolean {
	if (sameChildOrder(left, right)) return false;
	if (baseline === undefined) return true;
	const leftMoved = !sameChildOrder(left, baseline);
	const rightMoved = !sameChildOrder(right, baseline);
	return leftMoved && rightMoved;
}

function collectNodes(node: PageIRNode): Map<string, PageIRNode> {
	const out = new Map<string, PageIRNode>();
	const stack: PageIRNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		out.set(current.id, current);
		if (current.children) stack.push(...current.children);
	}
	return out;
}

function sameChildOrder(
	left: readonly PageIRNode[] | undefined,
	right: readonly PageIRNode[] | undefined,
): boolean {
	const a = left ?? [];
	const b = right ?? [];
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.id !== b[i]?.id) return false;
	}
	return true;
}
