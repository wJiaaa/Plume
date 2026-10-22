/**
 * Which loop drives a turn.
 *
 * The built-in one asks the model, runs whatever tools it asked for, and asks again until it stops
 * asking. That is one strategy among several — plan-then-execute, a loop that votes across several
 * replies, one that stops to check with a person on every write — and which is right depends on
 * what the agent is for, not on what this file happens to contain.
 *
 * Unbound — which is both hosts — it is `runAgent`. `useAgentLoop` is the seam a test swaps.
 */

import type { AgentEventSink } from "./events.ts";
import { runAgent, type AgentRunConfig, type AgentRunResult } from "./loop.ts";

export interface AgentLoop {
	run(config: AgentRunConfig, emit: AgentEventSink): Promise<AgentRunResult>;
}

let bound: AgentLoop | null = null;

export function useAgentLoop(next: AgentLoop | null): void {
	bound = next;
}

export function runTurn(config: AgentRunConfig, emit: AgentEventSink): Promise<AgentRunResult> {
	if (bound) return bound.run(config, emit);
	return runAgent(config, emit);
}
