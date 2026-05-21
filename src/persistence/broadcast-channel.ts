export interface BroadcastBridge {
	postUpdate(update: Uint8Array): void;
	onRemoteUpdate(handler: (update: Uint8Array) => void): () => void;
	readonly instanceId: string;
	destroy(): void;
}

interface BroadcastMessage {
	readonly instanceId: string;
	readonly payload: ArrayBufferLike;
}

export interface BroadcastBridgeOptions {
	readonly channelName: string;
	readonly onFault?: (reason: string) => void;
}

/**
 * Same-origin cross-tab Y.js update relay. Wraps a single
 * `BroadcastChannel` and tags every outbound message with a per-
 * adapter `instanceId` so a tab that receives its own echo (Node
 * polyfills and a few historic browsers do this) drops it instead of
 * applying the update twice.
 *
 * Falls back to a no-op bridge when `BroadcastChannel` is unavailable
 * (SSR, older Node, certain test environments).
 */
export function createBroadcastBridge(
	options: BroadcastBridgeOptions,
): BroadcastBridge {
	const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel })
		.BroadcastChannel;
	const instanceId = randomInstanceId();
	const handlers = new Set<(update: Uint8Array) => void>();

	if (typeof Ctor !== "function") {
		options.onFault?.("broadcast-channel-unavailable");
		return {
			postUpdate(): void {
				// no-op
			},
			onRemoteUpdate(): () => void {
				return () => {
					// no-op
				};
			},
			instanceId,
			destroy(): void {
				// no-op
			},
		};
	}

	let channel: BroadcastChannel | undefined;
	try {
		channel = new Ctor(options.channelName);
	} catch (error) {
		options.onFault?.(
			error instanceof Error
				? error.message
				: "broadcast-channel-construct-failed",
		);
		return {
			postUpdate(): void {
				// no-op
			},
			onRemoteUpdate(): () => void {
				return () => {
					// no-op
				};
			},
			instanceId,
			destroy(): void {
				// no-op
			},
		};
	}

	function messageListener(event: MessageEvent): void {
		const data = event.data as BroadcastMessage | undefined;
		if (!data || typeof data !== "object") return;
		if (data.instanceId === instanceId) return;
		const payload = data.payload;
		if (!(payload instanceof ArrayBuffer)) return;
		const update = new Uint8Array(payload);
		for (const handler of handlers) {
			try {
				handler(update);
			} catch {
				// listener errors must not poison sibling handlers.
			}
		}
	}

	channel.addEventListener("message", messageListener);

	return {
		postUpdate(update: Uint8Array): void {
			if (!channel) return;
			try {
				// Send the underlying ArrayBuffer so structured-clone
				// preserves the bytes exactly. Slice() in case the view
				// is over a larger buffer (Yjs typically returns tight
				// buffers, but defense-in-depth).
				const payload =
					update.byteOffset === 0 &&
					update.byteLength === update.buffer.byteLength
						? update.buffer
						: update.slice().buffer;
				const message: BroadcastMessage = { instanceId, payload };
				channel.postMessage(message);
			} catch (error) {
				options.onFault?.(
					error instanceof Error
						? error.message
						: "broadcast-channel-post-failed",
				);
			}
		},
		onRemoteUpdate(handler): () => void {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		instanceId,
		destroy(): void {
			channel?.removeEventListener("message", messageListener);
			try {
				channel?.close();
			} catch {
				// already closed
			}
			channel = undefined;
			handlers.clear();
		},
	};
}

function randomInstanceId(): string {
	const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `instance-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
