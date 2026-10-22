/**
 * What goes into a turn, and who gets to change it.
 *
 * Between "the session decided to run a turn" and "the request went out" there is one place where
 * everything the model will see exists as a value: the prompt, the messages, the tools. This is
 * that place, made explicit so a plugin can add to it — the current branch, a house style guide, a
 * warning that production credentials are loaded — without editing the session.
 *
 * Middleware, not a list of hooks: each one calls `next` and may inspect what came back, so a
 * plugin can also decide not to delegate and own the turn outright. First registered is outermost,
 * matching the kernel's `waterfall`, so the order reads the same wherever you meet it.
 */

import type { Message, Tool } from "../types.ts";

export interface TurnContext {
	systemPrompt: string;
	messages: Message[];
	tools: Tool[];
	cwd: string;
}

export type TurnMiddleware = (
	turn: TurnContext,
	next: (turn: TurnContext) => Promise<TurnContext>,
) => Promise<TurnContext>;

let pipeline: TurnMiddleware | null = null;

export function useTurnPipeline(middleware: TurnMiddleware | null): void {
	pipeline = middleware;
}

/**
 * Run the turn through whatever is registered.
 *
 * With nothing bound this returns its argument. The host binds the kernel's pipeline, which composes
 * its steps on the event bus — see `kernel/plugins/session.ts`.
 */
export async function prepareTurn(turn: TurnContext): Promise<TurnContext> {
	return pipeline ? pipeline(turn, async (final) => final) : turn;
}
