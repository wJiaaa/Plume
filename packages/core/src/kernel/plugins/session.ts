import type { TurnContext } from "../../runtime/turn.ts";
import type { Context, Plugin } from "../context.ts";
import { EVENTS, SESSION, type TurnPipeline } from "../services.ts";

/**
 * The conversation, as something plugins can take part in.
 *
 * Backed by the kernel's own event bus: a step added with `use` is a listener on `agent/prepare`,
 * and the ordering rule is the bus's — first registered is outermost, it sees the turn first and
 * the result last. A plugin that never touches this registry can take part by listening to the
 * event, and one that does is disposed by the context along with everything else it installed.
 *
 * Empty by default: an ordinary turn is the session's own prompt and the messages so far, and
 * anything added here is added to every request the user pays for.
 */
export const sessionPlugin: Plugin = {
	name: "session",
	apply(ctx: Context) {
		const pipeline: TurnPipeline = {
			use: (step) =>
				ctx.onWaterfall<[TurnContext], TurnContext>(EVENTS.turnPrepare, (turn, next) =>
					step(turn, next as (turn: TurnContext) => Promise<TurnContext>),
				),
			/*
			 * One middleware that dispatches to the bus, never a snapshot of the listeners: the host
			 * binds this once at boot, and a list captured then would miss every step added later.
			 * With no listeners the waterfall calls its base directly.
			 */
			middleware: (turn, next) => ctx.waterfall<TurnContext>(EVENTS.turnPrepare, [turn], (final) => next((final as TurnContext) ?? turn)),
		};
		return ctx.provide<TurnPipeline>(SESSION, pipeline);
	},
};
