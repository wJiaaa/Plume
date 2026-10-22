/**
 * The first of `keys` that holds a non-empty string.
 *
 * Models drift between names for the same argument (`query` where the schema says `pattern`), so
 * the tools accept a few aliases. `summarize` and `execute` both read through this: when they
 * each kept their own chain, one used `??` and the other skipped empty strings, and the card
 * could name a term the call never searched for.
 */
export function textArg(args: unknown, keys: readonly string[]): string | undefined {
	const raw = args as Record<string, unknown>;
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

/** What `grep` and `glob` look for, and where. */
export const PATTERN_KEYS = ["pattern", "query", "search"] as const;
export const ROOT_KEYS = ["path", "dir", "cwd"] as const;
