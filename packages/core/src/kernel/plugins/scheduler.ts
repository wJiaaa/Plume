import { fifoScheduler } from "../../runtime/scheduling.ts";
import type { Context, Plugin } from "../context.ts";
import { SCHEDULER, type TaskScheduler } from "../services.ts";

/** Which piece of queued work runs next. The built-in order is first in, first out — see `runtime/scheduling.ts`. */
export const schedulerPlugin: Plugin = {
	name: "scheduler",
	apply(ctx: Context) {
		return ctx.provide<TaskScheduler>(SCHEDULER, fifoScheduler);
	},
};
