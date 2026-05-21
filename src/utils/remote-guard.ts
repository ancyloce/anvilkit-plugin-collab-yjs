/**
 * Re-entrant in-flight guard threaded from `dispatchRemoteIR` into
 * `onDataChange` (H2).
 *
 * The old echo suppression matched only the FINAL remote Puck-data
 * key. When a single remote update produced several `replace` actions
 * and Puck emitted an `onDataChange` per action, the intermediate
 * states never matched that final key — so remote-origin states leaked
 * into the local save path and were written back as fake local edits,
 * amplifying remote bursts into extra saves.
 *
 * The guard is held active across the ENTIRE dispatch region — every
 * `replace` in the loop. Puck fires `onChange` synchronously inside
 * `api.dispatch`, so every intermediate per-`replace` emission lands
 * while the guard is active and is suppressed unconditionally (no
 * stringify, no per-state key matching). A genuine local edit that
 * happens immediately AFTER the dispatch returns is NOT suppressed.
 * The exact-key `pendingRemoteData` map (retained by the plugin) is
 * the precise fallback for a host that emits `onChange`
 * asynchronously after the dispatch returns — it only ever matches
 * the exact remote data, never a real local edit, so it cannot
 * swallow user input. A configurable grace window (default 0) is
 * available for pathological async hosts but is off by default.
 *
 * `begin()`/`end()` are depth-counted so nested or looped dispatch
 * stays "active" until the outermost dispatch finishes. Tokens are
 * monotonic so a stale `end(token)` from a failed dispatch cannot
 * prematurely re-open the guard.
 *
 * R5 — the grace window is timed with the monotonic `nowMs()` clock,
 * not `Date.now()`, so an NTP step / manual clock change can't make
 * the window fire spuriously or never. Callers MUST pass `nowMs()`
 * (not `Date.now()`) to `withinGraceWindow`.
 */
import { nowMs } from "./metrics.js";

export interface RemoteDispatchGuard {
  /** Enter a remote dispatch. Returns a monotonic token for `end`. */
  begin(): number;
  /** Leave the dispatch opened by `token`. Idempotent per token. */
  end(token: number): void;
  /** True while at least one dispatch is in flight. */
  isActive(): boolean;
  /**
   * True while a dispatch is active, or (only if `graceMs > 0`)
   * closed strictly within the last `graceMs`. With the default
   * `graceMs: 0` this is exactly `isActive()` — a local edit the
   * instant after dispatch returns is never suppressed here.
   */
  withinGraceWindow(now: number): boolean;
  /**
   * Record that an `onDataChange` was suppressed *while a dispatch
   * was active*. Lets `dispatchRemoteIR` learn, in its `finally`,
   * whether the host fired its echo synchronously (the common case —
   * Puck does) so the expensive exact-data fallback can be skipped
   * entirely on the hot path. No-op when no dispatch is active.
   */
  noteSuppressed(): void;
  /**
   * True iff at least one `onDataChange` was suppressed during the
   * most recently closed dispatch region. A synchronous host always
   * produces this; an async/pathological host does not, and only
   * then is the exact-data `pendingRemoteData` fallback needed.
   */
  consumedSyncEcho(): boolean;
}

export interface RemoteDispatchGuardOptions {
  /**
   * Milliseconds after the last dispatch closes during which
   * `onDataChange` is still treated as remote-origin echo. Default
   * 0 (disabled) — the active-during-dispatch guard plus the
   * exact-key fallback already cover correct hosts without any risk
   * of swallowing a fast local edit. Raise only for a pathological
   * host that emits `onChange` asynchronously after dispatch.
   */
  readonly graceMs?: number;
}

const DEFAULT_GRACE_MS = 0;

export function createRemoteDispatchGuard(
  options?: RemoteDispatchGuardOptions,
): RemoteDispatchGuard {
  const graceMs = options?.graceMs ?? DEFAULT_GRACE_MS;
  let depth = 0;
  let nextToken = 1;
  const openTokens = new Set<number>();
  let closedAt: number | undefined;
  // Suppressions observed since the outermost `begin()`; snapshotted
  // into `lastDispatchSyncSuppress` when the region closes.
  let syncSuppressInFlight = 0;
  let lastDispatchSyncSuppress = 0;

  return {
    begin(): number {
      const token = nextToken;
      nextToken += 1;
      openTokens.add(token);
      if (depth === 0) syncSuppressInFlight = 0;
      depth += 1;
      return token;
    },
    end(token: number): void {
      if (!openTokens.delete(token)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        closedAt = nowMs();
        lastDispatchSyncSuppress = syncSuppressInFlight;
      }
    },
    noteSuppressed(): void {
      if (depth > 0) syncSuppressInFlight += 1;
    },
    consumedSyncEcho(): boolean {
      return lastDispatchSyncSuppress > 0;
    },
    isActive(): boolean {
      return depth > 0;
    },
    withinGraceWindow(now: number): boolean {
      if (depth > 0) return true;
      if (graceMs <= 0 || closedAt === undefined) return false;
      // Strict `<` so an edit at the exact close instant (same ms
      // tick, synchronous) is treated as local, not echo.
      return now - closedAt < graceMs;
    },
  };
}
