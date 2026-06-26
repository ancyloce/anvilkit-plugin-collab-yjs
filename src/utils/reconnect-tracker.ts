/**
 * @file Reconnect attempt counter + jittered exponential backoff (§4.2.1).
 *
 * The `ConnectionStatus` model can represent a `reconnecting` attempt with an
 * `{ attempt, backoffMs }` pair, but the provider status mapping used to emit
 * the same static `{ attempt: 1, backoffMs: 250 }` on every reconnect. This
 * tracker owns the real semantics: it increments the attempt counter on each
 * disconnect→reconnect cycle, computes a jittered exponential backoff that
 * actually grows across attempts, and resets to zero once the transport syncs.
 *
 * Provider-agnostic and pure: the only source of nondeterminism — the jitter
 * randomness — is injectable via `rng`, so tests can pin it and assert the
 * backoff growth/reset deterministically. The computed backoff is surfaced
 * verbatim in `ConnectionStatus.backoffMs`, so a host can render it without
 * re-deriving the schedule.
 */

/** Tunables for the jittered exponential reconnect backoff schedule. */
export interface ReconnectBackoffOptions {
	/** First-attempt backoff before jitter, in ms. Default `250`. */
	readonly baseMs?: number;
	/**
	 * Hard ceiling the (pre-jitter) backoff is clamped to, in ms, so the
	 * schedule plateaus instead of growing without bound. Default `30000`.
	 */
	readonly maxMs?: number;
	/** Multiplier applied per attempt (`baseMs * factor^(attempt-1)`). Default `2`. */
	readonly factor?: number;
	/**
	 * Fraction of the computed backoff that is randomized (equal-jitter):
	 * the delay keeps `(1 - jitterRatio)` fixed and jitters the remaining
	 * `jitterRatio` by `rng()`. Clamped to `[0, 1]`. `0` disables jitter
	 * (fully deterministic). Default `0.5`.
	 */
	readonly jitterRatio?: number;
	/**
	 * Randomness source for the jitter, expected in `[0, 1)`. Injectable so
	 * tests can pin it; defaults to `Math.random`.
	 */
	readonly rng?: () => number;
}

/** One reconnect attempt's bookkeeping: 1-based counter + the jittered delay. */
export interface ReconnectState {
	/** 1-based attempt counter for the current outage; resets on `reset()`. */
	readonly attempt: number;
	/** Jittered backoff (ms, integer) the host should wait before retrying. */
	readonly backoffMs: number;
}

/**
 * Stateful reconnect bookkeeper. One instance lives per provider attach.
 */
export interface ReconnectTracker {
	/**
	 * Record a disconnect→reconnect cycle: increment the attempt counter and
	 * return the jittered backoff for that attempt.
	 */
	recordReconnect(): ReconnectState;
	/** Reset the attempt counter to zero — call on a successful `synced`. */
	reset(): void;
}

const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_JITTER_RATIO = 0.5;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

export function createReconnectTracker(
	options: ReconnectBackoffOptions = {},
): ReconnectTracker {
	const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
	const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
	const factor = options.factor ?? DEFAULT_FACTOR;
	const jitterRatio = clamp01(options.jitterRatio ?? DEFAULT_JITTER_RATIO);
	const rng = options.rng ?? Math.random;
	let attempt = 0;

	return {
		recordReconnect(): ReconnectState {
			attempt += 1;
			const uncapped = baseMs * factor ** (attempt - 1);
			const capped = Math.min(maxMs, uncapped);
			// Equal-jitter: keep `(1 - jitterRatio)` of the delay fixed and
			// randomize the rest. With a constant `rng` the result stays
			// strictly monotonic in `capped` (until the ceiling), which keeps
			// the "backoff grows" property testable.
			const jittered =
				capped * (1 - jitterRatio) + capped * jitterRatio * rng();
			return { attempt, backoffMs: Math.round(jittered) };
		},
		reset(): void {
			attempt = 0;
		},
	};
}
