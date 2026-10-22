/**
 * Keeping track of the remote calls that are running, so one of them can be stopped.
 *
 * An `AbortSignal` does not cross an IPC boundary, so the *name* of the operation does instead: the
 * renderer invents a token when it starts a fetch, and sends the same token back when the spinning
 * button is pressed a second time. This is the table in between.
 *
 * It lives in the main process rather than the renderer because this is the side that owns the git
 * process. A reloaded window would otherwise abandon a running `git fetch` with nothing left able
 * to reach it.
 */
export class RemoteCalls {
	private readonly running = new Map<string, AbortController>();

	/**
	 * Run `work`, reachable by `token` until it finishes.
	 *
	 * A token that is already running means the same request arrived twice rather than that two
	 * operations want the same name — a double-send, or a click that got through while the first
	 * was still in flight. The second is refused as a cancellation, which is silent: starting a
	 * second push against the same repository is the thing worth avoiding, and saying so would put
	 * an error on screen for something nobody did wrong.
	 *
	 * With no token there is nothing to cancel by, which is what the silent background fetch wants:
	 * it is never interrupted because nobody can see it to interrupt it.
	 */
	async run<T extends { ok: boolean; cancelled?: boolean }>(
		token: string | undefined,
		work: (signal?: AbortSignal) => Promise<T>,
	): Promise<T | { ok: false; cancelled: true }> {
		if (!token) return work();
		if (this.running.has(token)) return { ok: false, cancelled: true };
		const controller = new AbortController();
		this.running.set(token, controller);
		try {
			return await work(controller.signal);
		} finally {
			/*
			 * Always, including when `work` throws.
			 *
			 * A token left behind is worse than a leak: the next call using it would be refused as a
			 * duplicate of an operation that ended long ago, and the button would stop working with
			 * no explanation.
			 */
			this.running.delete(token);
		}
	}

	/** Stop the call running under this token. Unknown tokens are ignored — it may have just ended. */
	cancel(token: string): void {
		this.running.get(token)?.abort();
	}

	/** How many are in flight. For tests, and for asserting the table does not grow. */
	get size(): number {
		return this.running.size;
	}
}
