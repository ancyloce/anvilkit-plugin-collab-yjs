/**
 * R3 — typed `load()` failures so a host (e.g. a version-history UI)
 * can distinguish a snapshot that was *pruned by retention* from one
 * that is genuinely *missing* or *corrupted*, and degrade gracefully
 * ("this revision was pruned") instead of surfacing a generic throw.
 *
 * All three extend `Error` (and keep the exact legacy message text +
 * `cause`) so existing `instanceof Error` / message-substring callers
 * and tests keep working; the discriminating signal is the subclass
 * (`name` + `instanceof`).
 */

abstract class SnapshotError extends Error {
  /** The snapshot id the failed `load()` targeted. */
  readonly id: string;
  constructor(id: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.id = id;
  }
}

/** No snapshot with this id exists in the shared Y.Doc. */
export class SnapshotNotFoundError extends SnapshotError {
  override readonly name = "SnapshotNotFoundError";
}

/**
 * The snapshot was evicted by the `maxSnapshots` retention cap. This
 * is best-effort and **same-session**: it is raised when THIS adapter
 * instance performed the eviction (it tracks its own pruned ids).
 * Cross-peer or post-reload, an evicted id is indistinguishable from
 * one that never existed (retention deletes meta+payload atomically)
 * and surfaces as {@link SnapshotNotFoundError}; a host history UI
 * should pre-filter requests against the retained `list()`.
 * Recoverable: hide / disable the revision rather than treat it as
 * corruption.
 */
export class SnapshotPrunedError extends SnapshotError {
  override readonly name = "SnapshotPrunedError";
}

/**
 * The record is internally inconsistent — the payload failed to decode
 * (corrupt / schema-drifted), or metadata is present without its
 * payload (which, because retention deletes both atomically in one
 * synchronous transaction, indicates corruption, not eviction).
 */
export class SnapshotCorruptedError extends SnapshotError {
  override readonly name = "SnapshotCorruptedError";
}
