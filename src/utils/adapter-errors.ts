/**
 * §4.2.4 — typed construction-time failure for {@link createYjsAdapter}.
 *
 * Adapter options are validated eagerly so a misconfigured host fails
 * fast with an actionable message instead of silently binding to the
 * wrong (or a blank) shared `Y.Map` name, or attributing every local
 * write to an id-less peer. Extends `Error` (keeping the message text +
 * `cause`) so existing `instanceof Error` callers keep working; the
 * discriminating signal is the subclass (`name` + `instanceof`) plus the
 * `option` field naming the field that failed validation.
 */
export class InvalidAdapterOptionsError extends Error {
	override readonly name = "InvalidAdapterOptionsError";
	/** The option that failed validation (e.g. `"mapName"`, `"peer.id"`). */
	readonly option: string;
	constructor(option: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.option = option;
	}
}
