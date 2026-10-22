import { EventBus, type Middleware } from "./events.ts";

export type Disposer = () => void | Promise<void>;

/** A plugin: something that installs capabilities into a context and can take them back out. */
export interface Plugin {
	name: string;
	apply(ctx: Context): void | Disposer | Promise<void | Disposer>;
}

/**
 * A context: services, events, and the undo log that ties them together.
 *
 * This is the repository every capability is found in. A plugin never imports the thing it needs;
 * it names a key — `llm`, `tools`, `sessions` — and takes whatever is registered under it, which
 * is the entire point: the model adapter, the store, the approval policy can each be swapped for
 * another implementation without a line changing in anything that uses them. See
 * `kernel/services.ts` for the seams we define.
 *
 * Plugins start in the order they are listed. The host lists the built-in set first and installed
 * ones after it, so every seam already exists by the time a plugin someone installed is applied.
 *
 * Everything installed through a context is recorded so it can be reversed — that is what makes
 * a plugin swappable rather than merely present. A registration with no disposer is a leak that
 * only shows up the first time someone tries to reload.
 */
export class Context {
	readonly bus = new EventBus();
	private readonly services = new Map<string, unknown>();
	private readonly started: Disposer[] = [];
	private readonly disposers: Disposer[] = [];
	private disposed = false;

	/** Register a capability under its key. Returns the disposer that withdraws it. */
	provide<T>(key: string, value: T): Disposer {
		if (this.services.has(key)) {
			throw new Error(`Service "${key}" is already provided; withdraw it before replacing it.`);
		}
		this.services.set(key, value);

		const dispose = () => {
			if (this.services.get(key) === value) this.services.delete(key);
		};
		this.disposers.push(dispose);
		return dispose;
	}

	/** The capability registered under `key`, or undefined if nothing provides it. */
	get<T>(key: string): T | undefined {
		return this.services.get(key) as T | undefined;
	}

	/** As `get`, but for the many places where absence is a programming error rather than a state. */
	require<T>(key: string): T {
		const value = this.services.get(key);
		if (value === undefined) throw new Error(`Service "${key}" is not available.`);
		return value as T;
	}

	has(key: string): boolean {
		return this.services.has(key);
	}

	/** Install a plugin. What its `apply` returns is run when the context is disposed. */
	async use(plugin: Plugin): Promise<void> {
		const dispose = await plugin.apply(this);
		if (typeof dispose === "function") this.started.push(dispose);
	}

	on<A extends unknown[]>(event: string, listener: (...args: A) => void | Promise<void>): Disposer {
		const off = this.bus.on(event, listener as never);
		this.disposers.push(off);
		return off;
	}

	/** A listener that wraps the work: call `next()` to delegate, or return to decide. */
	onWaterfall<A extends unknown[], R>(event: string, listener: Middleware<A, R>): Disposer {
		const off = this.bus.on(event, listener as never);
		this.disposers.push(off);
		return off;
	}

	emit(event: string, ...args: unknown[]): void {
		this.bus.emit(event, ...args);
	}

	waterfall<R>(event: string, args: unknown[], base: (...args: unknown[]) => Promise<R>): Promise<R> {
		return this.bus.waterfall<R>(event, args, base);
	}

	/** Unwind everything, newest first, so teardown mirrors the order things were built in. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const dispose of [...this.started].reverse()) await dispose();
		for (const dispose of [...this.disposers].reverse()) await dispose();
		this.started.length = 0;
		this.disposers.length = 0;
		this.services.clear();
	}
}
