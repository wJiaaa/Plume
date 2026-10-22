import { runAgent } from "../../agent/loop.ts";
import type { AgentLoop } from "../../agent/runner.ts";
import type { Context, Plugin } from "../context.ts";
import { LOOP } from "../services.ts";

/**
 * Ask, run what was asked for, ask again.
 *
 * The default loop, and the one the rest of the app was written against: tool results go back to
 * the model as messages, the turn ends when the model stops requesting tools, and a stall is
 * nudged rather than abandoned.
 */
export const loopPlugin: Plugin = {
	name: "loop",
	apply(ctx: Context) {
		return ctx.provide<AgentLoop>(LOOP, { run: runAgent });
	},
};
