import { compactIfNeeded } from "../../runtime/compaction/compaction.ts";
import type { Context, Plugin } from "../context.ts";
import { COMPACTION, type CompactionStrategy } from "../services.ts";

/**
 * Summarise the middle, keep the ends.
 *
 * The built-in answer to a full window: the oldest turns become a summary, the most recent ones
 * survive verbatim. It reads well afterwards and it is cheap, which is most of why it is the
 * default — but it is a policy, and a long-running agent with a different shape of work may want
 * a different one.
 *
 * The request goes over whole and the defaults live in `compactIfNeeded`. Passing the first four
 * fields positionally once meant that binding the built-in strategy — what the desktop does at
 * boot — turned off the overhead accounting, artifact storage and the `compact` model.
 */
export const compactionPlugin: Plugin = {
	name: "compaction",
	apply(ctx: Context) {
		return ctx.provide<CompactionStrategy>(COMPACTION, { compact: compactIfNeeded });
	},
};
