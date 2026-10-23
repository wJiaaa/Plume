/**
 * Cutting a conversation back to a message, and everything that has to follow the cut.
 *
 * Undo and edit-and-resend make the same cut; they differ only in what happens around it (edit
 * stops a running turn first and asks again afterwards, undo refuses while a turn runs). The cut
 * itself is one thing, so it is written once — edit-and-resend once missed the plan step below,
 * while cutting just as much as undo and then running straight away.
 */

import type { AgentEventSink } from "../../agent/events.ts";
import { backgroundJobs } from "../../tools/background-jobs.ts";
import { TODOS_KEY, todosFromLog } from "../../tools/todo.ts";
import type { Message } from "../../types.ts";
import type { DetachedDispatches } from "../sub-agent/detached-dispatches.ts";
import type { SessionDeliveries } from "./session-deliveries.ts";
import type { SessionWakeups } from "./session-wakeups.ts";
import type { SessionLog } from "../record/session-log.ts";
import type { SubAgentRegistry } from "../sub-agent/sub-agents.ts";

export interface RewindParts {
	log: SessionLog;
	/** The session's tool state, where this turn's copy of the plan lives. */
	state: Map<string, unknown>;
	deliveries: SessionDeliveries;
	dispatches: DetachedDispatches;
	subAgents: SubAgentRegistry;
	wakeups: SessionWakeups;
	emit: AgentEventSink;
}

/** Drop every message from `messageIndex` on, and what was built on them. */
export async function rewind(parts: RewindParts, messageIndex: number): Promise<void> {
	const before = parts.log.messages.slice();
	if (!(await parts.log.truncateFrom(messageIndex))) {
		throw new Error(`Failed to truncate message at index ${messageIndex}`);
	}
	restorePlan(parts);
	stopCutDelegations(parts);
	// The store may move the cut back so a call keeps its result: what was cut is what is no longer there.
	stopCutWatches(parts, before.slice(parts.log.messages.length));
	await parts.emit({ type: "rewound", messageCount: parts.log.messages.length });
}

/**
 * The plan goes back to the cut too.
 *
 * It is written in two places — the result of a `todo_write` in the log, and the state this turn
 * uses. Truncating reaches only the first, so a plan no longer written anywhere in the transcript
 * went on voting for continuation: at the next step limit `continueWhileWorkRemains` would say
 * "3 items left on the list" and spend another two hundred steps on its own.
 *
 * Re-read from the truncated log rather than cleared: a plan written before the cut still counts.
 */
function restorePlan({ log, state }: RewindParts): void {
	const plan = todosFromLog(log.messages);
	if (plan.length > 0) state.set(TODOS_KEY, plan);
	else state.delete(TODOS_KEY);
}

/**
 * Background sub-agents whose dispatch was cut off are stopped, and their results no longer
 * delivered.
 *
 * A cut during a turn goes through `abort` first, which stops them all. A cut while idle used not
 * to touch them, so a sub-agent dispatched in the discarded part of the history ran to the end,
 * delivered its report and opened a turn — the main session picking up work that never happened in
 * its history, and paying another turn for it. Dispatches still in the history are left alone:
 * someone is still waiting for those results.
 */
function stopCutDelegations({ log, deliveries, dispatches, subAgents }: RewindParts): void {
	const dispatched = new Set<string>();
	for (const message of log.messages) {
		const id = message.role === "toolResult" ? (message.details as { subAgentId?: unknown } | undefined)?.subAgentId : undefined;
		if (typeof id === "string") dispatched.add(id);
	}
	// Ones already finished and waiting to be delivered are no longer in `dispatches`; filter them separately.
	deliveries.keepOnly(dispatched);
	for (const id of dispatches.forgetUnless((id) => dispatched.has(id))) subAgents.abort(id);
}

/**
 * Wakeups and monitors set up in the cut part go as well, for the same reason as the sub-agents:
 * left alone, ten minutes later a wakeup opens a turn about work no longer in the history, and a
 * monitor goes on delivering output nobody there asked to watch.
 *
 * Recognised by the result of the call that set them up — a monitor's job id, a wakeup's id — the
 * way a dispatch is by its `subAgentId`. Only those in the cut, rather than all but those still in
 * the history: a monitor's process or a wakeup that no tool call of this conversation made is not
 * this cut's to end.
 */
function stopCutWatches({ deliveries, state, wakeups }: RewindParts, cut: Message[]): void {
	const monitors = new Set<string>();
	const timers = new Set<string>();
	for (const message of cut) {
		if (message.role !== "toolResult") continue;
		const details = message.details as { kind?: unknown; id?: unknown; wakeup?: { id?: unknown } } | undefined;
		if (details?.kind === "monitor" && typeof details.id === "string") monitors.add(details.id);
		if (details?.kind === "wakeup" && typeof details.wakeup?.id === "string") timers.add(details.wakeup.id);
	}
	wakeups.cancelOnly(timers);
	if (monitors.size === 0) return;
	const jobs = backgroundJobs(state);
	for (const id of monitors) {
		try { jobs.stop(id); } catch { /* a monitor that will not die is no reason to fail the rewind; the panel shows it */ }
	}
	// One that already ended on its own may still have its last batch or its exit waiting to go out.
	deliveries.forgetJobs(monitors);
}
