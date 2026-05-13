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
		const overlap = computeOverlap(lastLocalIR, remoteIR);
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
			lastLocalIR = ir;
			if (firstUnconfirmedLocalSaveAt === undefined) {
				firstUnconfirmedLocalSaveAt = Date.now();
			}
		},
		maybeFire,
		closeWindow(): void {
			firstUnconfirmedLocalSaveAt = undefined;
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

function computeOverlap(local: PageIR, remote: PageIR): readonly string[] {
	const localNodes = collectNodes(local.root);
	const remoteNodes = collectNodes(remote.root);
	const overlap: string[] = [];
	for (const [id, localNode] of localNodes) {
		const remoteNode = remoteNodes.get(id);
		if (!remoteNode) continue;
		if (
			!shallowPropsEqual(localNode.props, remoteNode.props) ||
			!sameChildOrder(localNode.children, remoteNode.children)
		) {
			overlap.push(id);
		}
	}
	return overlap;
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

function shallowPropsEqual(
	left: Record<string, unknown> | undefined,
	right: Record<string, unknown> | undefined,
): boolean {
	if (left === right) return true;
	const a = left ?? {};
	const b = right ?? {};
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	for (const key of ak) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
	}
	return true;
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
