/**
 * A listener for `waterfall`: around-middleware.
 *
 * It receives the arguments plus `next`. Calling `next()` passes the (possibly altered) work to
 * whoever registered after it and yields their answer; returning without calling it stops there
 * and the answer is this listener's own. That is how a policy can own a decision outright while
 * an observer merely annotates and delegates.
 */
export type Middleware<A extends unknown[], R> = (...args: [...A, () => Promise<R>]) => R | Promise<R>;

type AnyListener = (...args: never[]) => unknown;

/**
 * A typed event bus.
 *
 * Deliberately small: registration returns its own disposer, because a plugin that is unloaded
 * must be able to take everything it installed with it. Anything that cannot be undone has no
 * place in a system whose whole premise is that capabilities are swappable.
 */
export class EventBus {
	private readonly listeners = new Map<string, AnyListener[]>();

	on(event: string, listener: AnyListener): () => void {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);

		return () => {
			const current = this.listeners.get(event);
			if (!current) return;
			const at = current.indexOf(listener);
			if (at >= 0) current.splice(at, 1);
		};
	}

	/** Fire and forget, in registration order. A throwing listener must not stop the others. */
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.snapshot(event)) {
			try {
				void (listener as (...a: unknown[]) => unknown)(...args);
			} catch {
				// An observer's failure is its own; the thing being announced still happened.
			}
		}
	}

	/**
	 * Around-middleware ending in `base`, with the value flowing forwards as well as back. The first
	 * registered listener is the outermost: it sees the request first and the answer last.
	 *
	 * A listener calls `next()` to pass what it was given, or `next(changed)` to pass something
	 * else — which is the difference between an around-hook and middleware. Without it a listener
	 * could only rewrite the result on the way out, and "amend what the model is about to be sent"
	 * would be impossible to express.
	 *
	 * Built by recursion rather than by folding a chain of thunks, because each step has to be able
	 * to hand different arguments to the one below it.
	 */
	async waterfall<R>(event: string, args: unknown[], base: (...args: unknown[]) => Promise<R>): Promise<R> {
		const chain = this.snapshot(event);
		const step = (index: number, current: unknown[]): Promise<R> => {
			if (index >= chain.length) return base(...current);
			const listener = chain[index] as (...a: unknown[]) => Promise<R>;
			return listener(...current, (...override: unknown[]) =>
				step(index + 1, override.length > 0 ? override : current),
			);
		};
		return step(0, args);
	}

	/** Listeners can register or dispose during dispatch; iterate a copy so that is safe. */
	private snapshot(event: string): AnyListener[] {
		return [...(this.listeners.get(event) ?? [])];
	}
}
