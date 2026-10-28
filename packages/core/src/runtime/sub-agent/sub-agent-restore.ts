/**
 * 进程退出之后，子代理还在：从会话日志里把它们读回来。
 *
 * 登记簿只在内存里，应用一关就没了——名单是空的，`resume` 只能得到一句「上下文已经不在了」，人说
 * 「继续」之后模型只好从零重派，把读过的再读一遍。而它做过的事一直在日志里：`subagent`（派了谁、
 * 让它做什么）、每一条 `subagent_message`、它在哪压缩过、哪些调用开始了、`subagent_done`。
 *
 * 这里从那几种记录重建两样东西：名单上的一行，和续跑要的上下文。
 *
 * 上下文要和它停下前最后发出去的那份逐字相同：缓存能留多久因服务商而异，重启得快的话还在，
 * 前缀对不上就是整段按原价重算。所以按它自己跑的那个模型重建（供应商句柄留着、压缩头按那个模型
 * 拼），压缩剪过的结果从 `subagent_views` 换回剪过的那份。见 ADR-0024。
 */

import type { AgentEvent, HookRun } from "../../agent/events.ts";
import { environmentDate, today, withEnvironment } from "../../prompt/environment.ts";
import { interruptedResult } from "../../session/live-calls.ts";
import { sessionPruner } from "../../agent/aged-prune.ts";
import { stripStaleHandles } from "../../agent/model-switch.ts";
import type { Boundary, SessionRecord } from "../../session/types.ts";
import { TODOS_KEY, todosFromLog } from "../../tools/todo.ts";
import { addUsage, emptyUsage, type AssistantContent, type Message } from "../../types.ts";
import { clearEnding, type SubAgentConversation } from "./sub-agents.ts";
import { LegacyCheckpoints } from "./sub-agent-restore-legacy.ts";
import { isFinalDemand } from "./yield-tool.ts";
import type { SubAgentSummary } from "../../types/sub-agent.ts";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
type Event<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

export interface RestoredSubAgent {
	summary: SubAgentSummary;
	/** What the pane shows: the transcript as it was written. */
	messages: Message[];
	/** 它跑过的钩子，各自的终态；`at` 落盘时就盖好了。 */
	hookRuns: HookRun[];
	/** Absent when there is no model to rebuild a compacted history against. */
	conversation?: SubAgentConversation;
	/** 没有 `subagent_done`：它跑着的时候进程没了，不是谁按停的。 */
	cutByExit?: boolean;
}

/**
 * How to turn a sub-agent's transcript into what the model it ran on sees: the id that model goes
 * by and the session's own `historyFrom`, bound to it. Undefined when there is no model to rebuild
 * against; the rows still come back, but none can be resumed.
 */
export type Rebuild = (ran: { provider?: string; model?: string }) => { model: string; history: (messages: Message[], boundary: Boundary | null) => Message[] } | undefined;

interface Draft {
	summary: SubAgentSummary;
	messages: Message[];
	/** The model its latest stretch ran on, as the `subagent` event names it. */
	ran: { provider?: string; model?: string };
	/** Where a resume switched models: handles before it were stripped then, so they are here too. */
	switchedAt: number;
	/** Results its compaction cut, by call id, with when it adopted them; see the `subagent_views` event. */
	views: Map<string, { message: Message; at: number }>;
	boundary: Boundary | null;
	/** Calls that got as far as `tool_start` — the ones that may have acted. */
	started: Set<string>;
	hookRuns: Map<string, HookRun>;
	lastSeen: number;
	/**
	 * 讨交接那一轮：从那句话起，到下一段开头那句之前。面板上照画，模型的历史里没有——跑着的时候
	 * `view` 就停在它之前（`sub-agent-run.ts`），续跑从那里接着。
	 */
	handoff: Set<Message>;
	handingOff: boolean;
	/** 旧日志没记下的那两处检查点，见 `sub-agent-restore-legacy.ts`。 */
	legacy: LegacyCheckpoints;
}

/**
 * The sub-agents in `records`, oldest first, less the ones taken off the roster by hand.
 */
export function restoreSubAgents(records: readonly SessionRecord[], rebuild?: Rebuild): RestoredSubAgent[] {
	const drafts = new Map<string, Draft>();
	const dismissed = new Set<string>();
	for (const record of untruncated(records)) {
		if (record.type !== "event") continue;
		const event = record.event;
		if (event.type === "subagent") {
			dispatched(drafts, event, record.ts);
			continue;
		}
		if (event.type === "subagent_dismissed") {
			dismissed.add(event.id);
			continue;
		}
		if (event.type !== "subagent_message" && event.type !== "subagent_event" && event.type !== "subagent_done" && event.type !== "subagent_views") continue;
		const draft = drafts.get(event.id);
		if (!draft) continue;
		if (event.type === "subagent_views") {
			for (const { toolCallId, message } of event.views) draft.views.set(toolCallId, { message, at: record.ts });
			continue;
		}
		draft.lastSeen = record.ts;
		if (event.type === "subagent_message") {
			if (!event.message) continue;
			const missing = draft.legacy.before(event.message);
			if (missing) draft.messages.push(missing);
			draft.messages.push(event.message);
			if (isFinalDemand(event.message)) draft.handingOff = true;
			if (draft.handingOff) draft.handoff.add(event.message);
			if (event.message.role === "assistant") draft.summary.usage = addUsage(draft.summary.usage, event.message.usage);
		} else if (event.type === "subagent_event") {
			const inner = event.event;
			draft.legacy.event(inner, draft.messages.length, record.ts);
			// Same arithmetic as the session's own boundary (`replay-records.ts`): the tail it kept is the tail of what was written.
			if (inner.type === "compacted" && inner.kept !== undefined) draft.boundary = { at: record.ts, summary: inner.summary ?? "", keptFrom: Math.max(0, draft.messages.length - inner.kept) };
			if (inner.type === "tool_start") {
				draft.started.add(inner.toolCallId);
				draft.summary.toolCalls += 1;
				draft.summary.lastActivity = inner.summary;
			}
			if (inner.type === "hook_run") draft.hookRuns.set(inner.run.id, inner.run);
		} else {
			const salvage = draft.legacy.salvageFrom(event);
			if (salvage !== undefined) for (const message of draft.messages.slice(salvage)) draft.handoff.add(message);
			draft.summary.status = event.status;
			draft.summary.endedAt = record.ts;
			if (event.answer) draft.summary.answer = event.answer;
			if (event.error) draft.summary.error = event.error;
			if (event.output) draft.summary.output = event.output;
			if (event.warnings?.length) draft.summary.warnings = event.warnings;
			if (event.incomplete) draft.summary.incomplete = true;
		}
	}

	return [...drafts.values()].filter((draft) => !dismissed.has(draft.summary.id)).map((draft) => {
		// No `subagent_done`: the process went away while it ran. Stopped, as far as anyone can tell now.
		const cutByExit = draft.summary.status === "running" || draft.summary.status === "queued";
		if (cutByExit) {
			draft.summary.status = "aborted";
			draft.summary.endedAt = draft.lastSeen;
		}
		const target = rebuild?.(draft.ran);
		return {
			summary: draft.summary,
			messages: draft.messages,
			hookRuns: [...draft.hookRuns.values()],
			...(target ? { conversation: conversationOf(draft, target) } : {}),
			...(cutByExit ? { cutByExit: true } : {}),
		};
	});
}

function dispatched(drafts: Map<string, Draft>, event: Event<"subagent">, at: number): void {
	const known = drafts.get(event.id);
	const model = ranOn(event);
	if (known) {
		// A resume: same row, running again. Its opening line arrived as a `subagent_message` just before.
		if (known.handingOff) {
			known.handingOff = false;
			const opening = known.messages.at(-1);
			if (opening) known.handoff.delete(opening);
		}
		known.legacy.dispatched();
		known.summary.status = "running";
		clearEnding(known.summary);
		known.summary.resumes = (known.summary.resumes ?? 0) + 1;
		known.lastSeen = at;
		known.summary.model = model ?? known.summary.model;
		if (event.provider !== known.ran.provider || event.model !== known.ran.model) {
			// `runSubAgent` stripped everything before this stretch's opening line, which is the last message.
			known.switchedAt = Math.max(0, known.messages.length - 1);
			known.ran = { provider: event.provider, model: event.model };
		}
		return;
	}
	drafts.set(event.id, {
		summary: {
			id: event.id,
			agent: event.agent,
			description: event.description,
			...(model ? { model } : {}),
			status: "running",
			startedAt: at,
			toolCalls: 0,
			usage: emptyUsage(),
		},
		// A fresh dispatch's opening line rides in the `subagent` event itself, not as a message.
		messages: [{ role: "user", content: [{ type: "text", text: event.prompt }], timestamp: at, origin: "parent" }],
		ran: { provider: event.provider, model: event.model },
		switchedAt: 0,
		views: new Map(),
		boundary: null,
		started: new Set(),
		hookRuns: new Map(),
		lastSeen: at,
		handoff: new Set(),
		handingOff: false,
		legacy: new LegacyCheckpoints(),
	});
}

/** 名单上那一行要的「跑在哪个模型上」；很早的日志连模型都没记，那就没有。 */
function ranOn(event: Event<"subagent">): SubAgentSummary["model"] {
	if (!event.provider || !event.model) return undefined;
	return { provider: event.provider, model: event.model, ...(event.thinking ? { thinking: event.thinking } : {}) };
}

/** Records a rewind cut off, gone — the same rule the session's own replay follows. */
function untruncated(records: readonly SessionRecord[]): SessionRecord[] {
	let kept: SessionRecord[] = [];
	for (const record of records) {
		if (record.type === "truncate") kept = kept.filter((one) => one.seq <= record.afterSeq);
		else kept.push(record);
	}
	return kept;
}

function conversationOf(draft: Draft, target: NonNullable<ReturnType<Rebuild>>): SubAgentConversation {
	const stripped = draft.switchedAt > 0 ? stripStaleHandles(draft.messages, draft.switchedAt) : draft.messages;
	// `stripStaleHandles` 只换动过的那几条，按位置对回去认讨交接那一轮。
	const transcript = stripped.filter((_message, index) => !draft.handoff.has(draft.messages[index]!));
	const ordered = paired(transcript, draft.started, draft.lastSeen);
	// The boundary named a position in the transcript as written; find the same message in the reordered one.
	const kept = draft.boundary ? stripped.slice(draft.boundary.keptFrom).find((message) => ordered.includes(message)) : undefined;
	const boundary = draft.boundary && {
		...draft.boundary,
		keptFrom: kept === undefined ? ordered.length : ordered.indexOf(kept),
	};
	const view = withEnvironment(target.history(ordered, boundary));
	const plan = todosFromLog(ordered);
	// 读过哪些文件不带回来：进程换过，文件可能也变过，它要改哪个就先重读哪个。清单带回来——检查点上要不要接着跑，看的就是它。
	const state = new Map<string, unknown>(plan.length > 0 ? [[TODOS_KEY, plan]] : []);
	if (draft.views.size > 0) {
		const pruner = sessionPruner(state);
		for (const message of ordered) {
			const cut = message.role === "toolResult" ? draft.views.get(message.toolCallId) : undefined;
			if (cut) pruner.remember(message, cut.message, cut.at);
		}
	}
	return { agent: draft.summary.agent, view, state, envDate: environmentDate(view) ?? today(), model: target.model };
}

/**
 * Every call answered, right after the reply that made it.
 *
 * Two things in a transcript as written break that, and a provider rejects the whole request for
 * either. Something said to it while a tool ran is written when it was said — between the call and
 * its result — while the loop only read it after the result; it goes back after the results. And a
 * call the process died during has no result at all; it gets the same "interrupted" the session's
 * own calls get on reopening.
 */
function paired(messages: readonly Message[], started: Set<string>, at: number): Message[] {
	const out: Message[] = [];
	let open: ToolCall[] = [];
	let held: Message[] = [];
	const close = () => {
		for (const call of open) out.push(interruptedResult(call, started.has(call.id) ? { callId: call.id, phase: "running", output: null } : undefined, at));
		open = [];
		out.push(...held);
		held = [];
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			close();
			out.push(message);
			open = message.content.filter((block): block is ToolCall => block.type === "toolCall");
		} else if (message.role === "toolResult") {
			out.push(message);
			open = open.filter((call) => call.id !== message.toolCallId);
			if (open.length === 0) close();
		} else if (open.length > 0) held.push(message);
		else out.push(message);
	}
	close();
	return out;
}
