/**
 * The transcript a session's records add up to.
 *
 * Pure, over records already read: the store decides which kinds to fetch (`REPLAY_KINDS`), this
 * decides what they mean. `truncate` is honoured here rather than by deleting rows — history is
 * never edited, so a reader has to know that a tail was voided and leave it out.
 */

import { completedCompaction, interruptedCompaction } from "../agent/compaction-lifecycle.ts";
import type { CommandRun, HookRun } from "../agent/events.ts";
import type { Message, Usage } from "../types.ts";
import { addUsage, emptyUsage } from "../types.ts";
import type { Boundary, SessionRecord } from "./types.ts";

/** The record kinds `replayRecords` reads. Everything else — prompts, requests, tool starts — is skipped unread. */
export const REPLAY_KINDS = ["message", "usage", "subagent_message", "compacted", "command_status", "hook_run", "truncate"] as const;

/** One compaction still in the transcript: where it sits, and what its divider says. */
export interface CompactionMark {
	/** The number of messages before it. */
	at: number;
	summary?: string;
	before: number;
	after: number;
}

export interface Replayed {
	/** Kept with their sequence numbers so a truncate record can drop the right tail. */
	entries: { seq: number; message: Message }[];
	/**
	 * Where history was summarised, as positions in the transcript. Recorded while replaying rather
	 * than derived, because the messages themselves do not show it: the log keeps every original
	 * either way. The window draws a divider at each.
	 */
	compactions: CompactionMark[];
	commandRuns: CommandRun[];
	hookRuns: HookRun[];
	/**
	 * And the newest of them in full, which is what the *model* is given. Only the latest matters:
	 * each compaction summarises the one before it.
	 */
	compaction: Boundary | null;
	/**
	 * Where `compaction` was written, which is where a fork writes it back (`trajectory/fork.ts`).
	 * A rewind into the tail it kept takes its divider off `compactions` but not the boundary, so
	 * this is held apart and pulled back to the new end instead.
	 */
	boundaryMark: CompactionMark | null;
	/** Everything the surviving transcript spent, sub-agents and side calls included. */
	usage: Usage;
	/** See `SessionMeta.turns`, `replyUsage`, `steps` and `subagentUsage`. */
	turns: number;
	replyUsage: Usage;
	steps: number;
	subagentUsage: Usage;
}

export function replayRecords(records: Iterable<SessionRecord>): Replayed {
	let entries: { seq: number; message: Message }[] = [];
	let auxiliaryUsage = emptyUsage();
	const compactions: CompactionMark[] = [];
	const commandRuns = new Map<string, { seq: number; run: CommandRun }>();
	const hookRuns = new Map<string, { seq: number; run: HookRun }>();
	let subagentEntries: { seq: number; usage: Usage }[] = [];
	let compaction: Boundary | null = null;
	let boundaryMark = null as CompactionMark | null;

	for (const record of records) {
		if (record.type === "event" && record.event.type === "command_status") {
			const run = record.event.command;
			commandRuns.set(run.id, { seq: record.seq, run });
		} else if (record.type === "event" && record.event.type === "hook_run") {
			hookRuns.set(record.event.run.id, { seq: record.seq, run: record.event.run });
		} else if (record.type === "event" && record.event.type === "compacted") {
			const { summary, kept, before, after } = record.event;
			const mark: CompactionMark = { at: entries.length, summary, before, after };
			compactions.push(mark);
			/*
			 * `kept` is absent on pruning passes that moved no boundary: no boundary to restore, so
			 * the session opens on its full history and compacts again if it has to.
			 */
			if (kept !== undefined) {
				compaction = { at: record.ts, summary: summary ?? "", keptFrom: Math.max(0, entries.length - kept) };
				boundaryMark = mark;
				// The boundary is the commit record; the UI completion event may not have reached disk.
				const entry = record.event.commandId ? commandRuns.get(record.event.commandId) : undefined;
				if (entry?.run.status === "running") {
					entry.seq = record.seq;
					entry.run = record.event.command ?? completedCompaction(entry.run, record.event.before, record.event.after);
				}
			}
		} else if (record.type === "event" && record.event.type === "subagent_message" && record.event.message.role === "assistant") {
			subagentEntries.push({ seq: record.seq, usage: record.event.message.usage });
		} else if (record.type === "message") {
			// `{"type":"message"}` is what an undefined message serialises to; a hole here once took the window down.
			if (record.message) entries.push({ seq: record.seq, message: record.message });
		} else if (record.type === "usage") {
			auxiliaryUsage = addUsage(auxiliaryUsage, record.usage);
		} else if (record.type === "truncate") {
			entries = entries.filter((e) => e.seq <= record.afterSeq);
			subagentEntries = subagentEntries.filter((e) => e.seq <= record.afterSeq);
			for (const [id, entry] of commandRuns) if (entry.seq > record.afterSeq) commandRuns.delete(id);
			for (const [id, entry] of hookRuns) if (entry.seq > record.afterSeq) hookRuns.delete(id);
			while (compactions.length && compactions[compactions.length - 1].at > entries.length) compactions.pop();
			// A rewind past the boundary retires it: the tail it was paired with is gone.
			if (compaction && compaction.keptFrom > entries.length) {
				compaction = null;
				boundaryMark = null;
			} else if (boundaryMark && boundaryMark.at > entries.length) boundaryMark = { ...boundaryMark, at: entries.length };
		}
	}

	let replyUsage = emptyUsage();
	let turns = 0;
	let steps = 0;
	for (const { message } of entries) {
		if (message.role === "assistant") {
			steps += 1;
			if (message.usage) replyUsage = addUsage(replyUsage, message.usage);
		} else if (message.role === "user" && !message.synthetic) turns += 1;
	}
	let subagentUsage = emptyUsage();
	for (const entry of subagentEntries) if (entry.usage) subagentUsage = addUsage(subagentUsage, entry.usage);
	const usage = addUsage(addUsage(auxiliaryUsage, replyUsage), subagentUsage);

	return {
		entries,
		compactions,
		compaction,
		boundaryMark,
		commandRuns: [...commandRuns.values()].map(({ run }) => (run.status === "running" ? interruptedCompaction(run) : run)),
		hookRuns: [...hookRuns.values()].map(({ run }) => run),
		usage,
		turns,
		replyUsage,
		steps,
		subagentUsage,
	};
}
