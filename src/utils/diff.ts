import type { PageIR } from "@anvilkit/core/types";
import { diffIR, type IRDiff } from "@anvilkit/plugin-version-history";

/**
 * L2 — snapshot-diff helper. Computes the structural `IRDiff` between
 * two `PageIR` values; thin alias over {@link diffIR} from the
 * version-history plugin to keep the call site domain-aligned ("I'm
 * diffing snapshots, not arbitrary IRs"). Adapter `save()` calls this
 * automatically when `createYjsAdapter({ computeDelta: true })` is set,
 * and attaches the result as `SnapshotMeta.delta`.
 *
 * Hosts that want to diff arbitrary pairs (e.g. for audit logs or
 * undo-stack replay) can call this directly.
 */
export function diffSnapshots(previous: PageIR, next: PageIR): IRDiff {
	return diffIR(previous, next);
}
