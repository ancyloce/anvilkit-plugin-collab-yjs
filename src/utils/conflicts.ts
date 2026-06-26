import type { PageIR, PageIRNode } from "@anvilkit/core/types";
import type { PeerInfo, Unsubscribe } from "@anvilkit/plugin-version-history";
import type {
	ConflictEvent,
	ConflictFieldDetail,
	ConflictResolution,
	ResolveConflict,
} from "../types/types.js";
import { nowMs } from "./metrics.js";

export interface ConflictModule {
	onConflict(callback: (event: ConflictEvent) => void): Unsubscribe;
	noteLocalSave(ir: PageIR): void;
	/**
	 * Evaluate a freshly-merged remote IR against the local in-flight edit.
	 * Fires `onConflict` for a true overlap and, when a `resolveConflict`
	 * hook was supplied (§4.2.3), returns the host-chosen merged `PageIR`
	 * the adapter must write back into the doc. Returns `undefined` when
	 * there is no conflict, no hook, or the hook kept the default
	 * last-write-wins value.
	 */
	maybeFire(remoteIR: PageIR, remotePeer?: PeerInfo): PageIR | undefined;
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
	resolveConflict?: ResolveConflict,
): ConflictModule {
	const conflictListeners = new Set<(event: ConflictEvent) => void>();
	let lastLocalIR: PageIR | undefined;
	let baselineIR: PageIR | undefined;
	let firstUnconfirmedLocalSaveAt: number | undefined;

	function maybeFire(
		remoteIR: PageIR,
		remotePeer?: PeerInfo,
	): PageIR | undefined {
		// Skip all work when nothing can consume the result: no listeners
		// AND no merge-strategy hook.
		if (conflictListeners.size === 0 && resolveConflict === undefined) {
			return undefined;
		}
		if (
			firstUnconfirmedLocalSaveAt === undefined ||
			lastLocalIR === undefined
		) {
			return undefined;
		}
		// R5 — monotonic: staleness is a correctness window, not a
		// display value, so a wall-clock step must not skew it.
		const elapsed = nowMs() - firstUnconfirmedLocalSaveAt;
		if (elapsed > staleAfterMs) return undefined;
		const { nodeIds, fields } = computeConflict(
			baselineIR,
			lastLocalIR,
			remoteIR,
		);
		if (nodeIds.length === 0) return undefined;
		const event: ConflictEvent = {
			kind: "overlap",
			localPeer,
			remotePeer,
			nodeIds,
			at: new Date().toISOString(),
			fields,
		};
		for (const listener of conflictListeners) {
			try {
				listener(event);
			} catch {
				// listener errors are swallowed; conflict reporting must
				// not poison the subscribe path.
			}
		}
		// §4.2.3 — consult the optional merge-strategy hook. Default
		// (no hook) keeps pure last-write-wins: nothing is written back.
		if (resolveConflict === undefined) return undefined;
		let resolution: ConflictResolution | undefined;
		try {
			resolution = resolveConflict(event);
		} catch {
			// A faulty hook must never corrupt the doc — fall back to the
			// default converged (remote-wins) value.
			return undefined;
		}
		return buildResolvedIR(remoteIR, event, resolution);
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
				firstUnconfirmedLocalSaveAt = nowMs();
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

interface ComputedConflict {
	readonly nodeIds: readonly string[];
	readonly fields: readonly ConflictFieldDetail[];
}

/**
 * Compute the node ids that represent a TRUE concurrent-edit conflict
 * between the local peer and the remote peer, together with the §4.2.3
 * per-field detail (which prop keys conflicted, and their local/remote
 * values) for the SAME-prop overlaps.
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
 *
 * The `nodeIds` returned here are byte-identical to the pre-§4.2.3
 * `computeOverlap` result (the boolean overlap test is exactly
 * "`propConflictFields` non-empty OR `childOrderConflict`"); `fields`
 * is the additive enrichment.
 */
function computeConflict(
	baseline: PageIR | undefined,
	local: PageIR,
	remote: PageIR,
): ComputedConflict {
	const localNodes = collectNodes(local.root);
	const remoteNodes = collectNodes(remote.root);
	const baselineNodes = baseline ? collectNodes(baseline.root) : undefined;
	const nodeIds: string[] = [];
	const fields: ConflictFieldDetail[] = [];
	for (const [id, localNode] of localNodes) {
		const remoteNode = remoteNodes.get(id);
		if (!remoteNode) continue;
		const baselineNode = baselineNodes?.get(id);
		const conflictingFields = propConflictFields(
			id,
			localNode.props,
			remoteNode.props,
			baselineNode?.props,
		);
		const childOrder = childOrderConflict(
			localNode.children,
			remoteNode.children,
			baselineNode?.children,
		);
		if (conflictingFields.length > 0 || childOrder) {
			nodeIds.push(id);
			fields.push(...conflictingFields);
		}
	}
	return { nodeIds, fields };
}

/**
 * §4.2.3 — the prop keys on which BOTH peers diverged (the same boolean
 * predicate the legacy `propsConflict` used, now collecting detail). Each
 * returned {@link ConflictFieldDetail} carries the raw local and converged
 * remote value so a host can render a semantic merge.
 */
function propConflictFields(
	nodeId: string,
	left: Record<string, unknown> | undefined,
	right: Record<string, unknown> | undefined,
	baseline: Record<string, unknown> | undefined,
): ConflictFieldDetail[] {
	const a = left ?? {};
	const b = right ?? {};
	const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
	const out: ConflictFieldDetail[] = [];
	for (const key of keys) {
		const aRaw = JSON.stringify(a[key]);
		const bRaw = JSON.stringify(b[key]);
		if (aRaw === bRaw) continue;
		if (baseline === undefined) {
			// No baseline anchor — fall back to divergence-as-conflict
			// (preserves legacy semantics for first-save scenarios).
			out.push({ nodeId, field: key, localValue: a[key], remoteValue: b[key] });
			continue;
		}
		const baseRaw = JSON.stringify(baseline[key]);
		// True conflict iff BOTH peers diverged from baseline on this
		// prop. If only one side moved, the CRDT merged cleanly and
		// nothing is at risk.
		if (aRaw !== baseRaw && bRaw !== baseRaw) {
			out.push({ nodeId, field: key, localValue: a[key], remoteValue: b[key] });
		}
	}
	return out;
}

/**
 * §4.2.3 — turn a host {@link ConflictResolution} into the concrete
 * `PageIR` to write back, layered over the converged remote state.
 * Returns `undefined` when the resolution keeps the default remote-wins
 * value, or when it produces no material change (so the adapter skips the
 * write-back entirely).
 */
function buildResolvedIR(
	remoteIR: PageIR,
	event: ConflictEvent,
	resolution: ConflictResolution | undefined,
): PageIR | undefined {
	if (resolution === undefined || resolution === "remote") return undefined;
	const overrides = new Map<string, Map<string, unknown>>();
	const add = (nodeId: string, field: string, value: unknown): void => {
		let perNode = overrides.get(nodeId);
		if (!perNode) {
			perNode = new Map<string, unknown>();
			overrides.set(nodeId, perNode);
		}
		perNode.set(field, value);
	};
	if (resolution === "local") {
		for (const detail of event.fields ?? []) {
			add(detail.nodeId, detail.field, detail.localValue);
		}
	} else {
		for (const [nodeId, fieldMap] of Object.entries(resolution.fields)) {
			for (const [field, value] of Object.entries(fieldMap)) {
				add(nodeId, field, value);
			}
		}
	}
	if (overrides.size === 0) return undefined;
	const merged = applyOverrides(remoteIR, overrides);
	return merged === remoteIR ? undefined : merged;
}

/**
 * Structurally clone `ir`, overriding the given prop values on the named
 * nodes. Returns the same reference when nothing materially changed (an
 * override that already matched the converged value).
 */
function applyOverrides(
	ir: PageIR,
	overrides: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): PageIR {
	let changed = false;
	const visit = (node: PageIRNode): PageIRNode => {
		let nextChildren = node.children;
		if (node.children) {
			const mapped = node.children.map(visit);
			if (mapped.some((child, i) => child !== node.children?.[i])) {
				nextChildren = mapped;
				changed = true;
			}
		}
		const perNode = overrides.get(node.id);
		let nextProps = node.props;
		if (perNode) {
			let propsChanged = false;
			const draft: Record<string, unknown> = { ...node.props };
			for (const [field, value] of perNode) {
				if (JSON.stringify(draft[field]) !== JSON.stringify(value)) {
					draft[field] = value;
					propsChanged = true;
				}
			}
			if (propsChanged) {
				nextProps = draft;
				changed = true;
			}
		}
		if (nextProps === node.props && nextChildren === node.children) {
			return node;
		}
		// Preserve the node's exact shape: only carry `children` when the
		// source node had it, so a leaf never gains an explicit
		// `children: undefined` key.
		return nextChildren === undefined
			? { ...node, props: nextProps }
			: { ...node, props: nextProps, children: nextChildren };
	};
	const root = visit(ir.root);
	return changed ? { ...ir, root } : ir;
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
