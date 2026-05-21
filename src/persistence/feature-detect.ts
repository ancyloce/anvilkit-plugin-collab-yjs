/**
 * Runtime guards for the L5 persistence layer. Persistence is opt-in,
 * but even when opted in, hosts may execute in environments where the
 * underlying APIs are unavailable (SSR, older Node versions, certain
 * test runners). Every entry point in `./index.ts` checks these
 * guards first and falls back to no-op backends silently.
 */
export function hasIndexedDb(): boolean {
	return (
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined"
	);
}

export function hasBroadcastChannel(): boolean {
	return (
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel ===
			"function"
	);
}
