import { translate } from "../i18n/translate.ts";
/**
 * Reading state back out of a transcript.
 *
 * When a stored conversation is opened there are no events to replay — only messages. Everything
 * the UI needs beyond the messages themselves (the tool cards, the plan, whether the run was cut
 * short) is derived here, from the same source the model saw.
 *
 * The session cache lives here too, for the same reason: it is a pure function of transcripts.
 */

import type { Message, TodoItem } from "@plume/core";
import type { SessionMeta } from "@plume/core";
import type { TurnStop } from "./turn-stop.ts";
import { routedMcpCall, summarizeToolCall } from "../lib/tool-summary.ts";
import type { AppState } from "./index.ts";
import type { ToolRun } from "./tool-run.ts";

/** 一个会话这一轮的状态：屏上那个摊在 `AppState` 顶层，停在缓存里的放在 `state` 里，两边同一组字段。 */
export type CachedSessionState = Pick<AppState, "running" | "todos" | "compactions" | "approvals" | "stopped" | "retrying" | "capabilities" | "pendingUserMessage" | "commandRuns" | "hookRuns" | "hiccups" | "compactedAt">;

/** 什么都还没发生。数组是共用的同一份：各处只换不改，读的一方拿它当「空」时引用不变，不会白白重画。 */
export const EMPTY_SLOT: CachedSessionState = {
	running: false, todos: [], compactions: [], approvals: [], stopped: null, retrying: null,
	capabilities: null, pendingUserMessage: null, commandRuns: [], hookRuns: [], hiccups: [], compactedAt: null,
};

/** 屏上那个会话的这一组字段，存进缓存时用。 */
export function slotState(state: CachedSessionState): CachedSessionState {
	return {
		running: state.running, todos: state.todos, compactions: state.compactions, approvals: state.approvals, stopped: state.stopped,
		retrying: state.retrying, capabilities: state.capabilities, pendingUserMessage: state.pendingUserMessage,
		commandRuns: state.commandRuns, hookRuns: state.hookRuns, hiccups: state.hiccups, compactedAt: state.compactedAt,
	};
}

/**
 * The live slot holding nobody: what 新对话, a focused blank screen, and a conversation taken away
 * under you all leave in it.
 *
 * Everything here belongs to the conversation being left, and carrying any of it into the blank one
 * reports on the wrong conversation — a turn meter, a connection shown as broken, a pause offered
 * for resuming.
 */
export function blankSlot(get: () => AppState): Partial<AppState> {
	return {
		...EMPTY_SLOT,
		selectionEpoch: get().selectionEpoch + 1,
		activeSessionId: null,
		pendingSessionId: null,
		meta: null,
		messages: [],
		toolRuns: {},
		turnStartedAt: null,
		turnTokens: 0,
		loadingSession: false,
	};
}

export type Cache = Record<
  string,
  {
    meta: SessionMeta;
    messages: Message[];
    toolRuns: Record<string, ToolRun>;
    state?: CachedSessionState;
	/** Live events advance beyond the stored sequence until the next authoritative read. */
	dirty?: boolean;
  }
>;

/** How many transcripts to hold. Enough to cover switching around a project, not a whole day. */
const CACHE_LIMIT = 12;

/** True when the parked copy is the same finished log the sidebar is pointing at. */
export function cacheIsFresh(cached: Cache[string] | undefined, meta: SessionMeta): cached is Cache[string] {
	return Boolean(cached && !cached.dirty && !cached.state?.running && cached.meta.seq === meta.seq);
}

/**
 * Drop the least recently used entries, never the one being opened.
 *
 * 侧边聊天也不丢：它只活在缓存里（不会被选成当前会话），面板开着就一直从这里读。丢了它，面板就停在
 * 加载上，而它不会被谁再读一遍。关掉一格时它随会话一起删（`applySessionChange`），不靠这里。
 */
export function prune(cache: Cache, keep: string): Cache {
  const ids = Object.keys(cache).filter((id) => !cache[id]!.meta.parentId);
  if (ids.length <= CACHE_LIMIT) return cache;
  const next = { ...cache };
  // Insertion order is recency order here: entries are re-added as sessions are visited.
  let excess = ids.length - CACHE_LIMIT;
  for (const id of ids) {
    if (excess === 0) break;
    if (id === keep) continue;
    delete next[id];
    excess--;
  }
  return next;
}

export function without<T>(cache: Record<string, T>, id: string): Record<string, T> {
  if (!(id in cache)) return cache;
  const next = { ...cache };
  delete next[id];
  return next;
}


/**
 * The wordings 「继续」 sends, which are the same act as an automatic nudge.
 *
 * Constants rather than a sentence written next to each button, because `grouping.ts` matches
 * these exact strings to tell "carrying on" apart from "asking something new" — that is what keeps
 * a task's elapsed time and tokens whole across an interruption. A second copy is a mismatch
 * waiting for the day somebody improves the wording.
 *
 * **Not translated, and that is deliberate.** Nobody reads these: `resumesTurn` folds the message
 * into the turn above it, so it never reaches the transcript. What they are is two things that
 * both need to stay put — the text handed to the model, and the mark a saved transcript is
 * recognised by. Route them through `translate` and the table freezes into whatever language the
 * window started in; a conversation carried on in Chinese and reopened in English stops matching,
 * `resumesTurn` calls it a new question, and every interrupted turn from then on reports the
 * length of its last leg. Which is precisely the failure this constant exists to prevent, and it
 * is invisible: the suite walks this table, so a table that moved with the language stayed green.
 */
// i18n-exempt: 发给模型的文本，同时是历史转录的标识——翻译它会让老会话的续跑认不出来。
export const CARRY_ON_PROMPTS = [
	"继续，从暂停的地方接着做。",
	"继续，从中断的地方接着做。",
	"继续，把清单里没做完的做完。",
] as const;

/**
 * What 「继续」 should say after a turn stopped this way — `null` when there is nothing to carry on.
 *
 * The other half of the distinction `TurnStop` draws: that says why the three stops read differently
 * to a person, and this is what they mean to the model,
 * which acts on the sentence. 「从中断的地方接着做」 about a pause you performed yourself is a
 * wrong account of where it stopped, and therefore a wrong instruction.
 *
 * The last case is the quiet one: nothing went wrong at all, the model simply ended its turn with
 * items still on its own list. `null` is the fourth answer — a conversation that finished with
 * nothing left in it, where the offer should not appear.
 *
 * Both the row under the transcript and the composer's button ask this, so that a pause offers the
 * same thing in both places and sends the same sentence from either.
 */
export function carryOnPrompt(stopped: TurnStop, unfinished: number): (typeof CARRY_ON_PROMPTS)[number] | null {
	if (stopped === "user") return CARRY_ON_PROMPTS[0];
	if (stopped === "error" || stopped === "interrupt") return CARRY_ON_PROMPTS[1];
	return unfinished > 0 ? CARRY_ON_PROMPTS[2] : null;
}

/**
 * Whether there is anything to re-ask.
 *
 * `retryFrom` walks back to the nearest message a person actually typed; with none in the
 * transcript it is a button that does nothing, which is worse than a button that is not there.
 */
export function hasRetryPoint(messages: Message[]): boolean {
	return messages.some((message) => message.role === "user" && !message.synthetic);
}

/**
 * The last task list written in a conversation.
 *
 * Searched backwards because `todo_write` sends the whole list every time — the newest one is
 * the only one that matters, and the ones before it are its earlier drafts.
 */
export function todosFrom(messages: Message[]): TodoItem[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && message.clearsTaskPlan === true) return [];
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;
		const details = message.details as { kind?: string; todos?: TodoItem[] } | undefined;
		if (details?.kind === "todo" && Array.isArray(details.todos)) return details.todos;
	}
	return [];
}

/**
 * Reconstruct tool cards when opening a stored session.
 *
 * `running` is the main process's word that the turn is still in flight, and `live` the records this
 * window already holds for the conversation — see the end of the function for what both are for.
 */
export function rebuildToolRuns(messages: Message[], running = false, live: Record<string, ToolRun> = {}): Record<string, ToolRun> {
  const runs: Record<string, ToolRun> = {};
  const asCalled = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const routed = routedMcpCall(block.name, block.arguments);
        if (routed.name !== block.name) asCalled.set(block.id, block.arguments);
        runs[block.id] = {
          toolCallId: block.id,
          toolName: routed.name,
          summary: summarizeToolCall(routed.name, routed.args),
          args: routed.args,
          status: "running",
          startedAt: message.timestamp,
        };
      }
    } else if (message.role === "toolResult") {
      const run = runs[message.toolCallId];
      if (run) {
        // 结果上记的是真正跑的那个工具（名字大小写纠正过、经 `mcp_call` 换过）；参数没对上被拦下的
        // `mcp_call` 记的还是它自己——两种都和直播时那张卡一致。
        if (message.toolName && message.toolName !== run.toolName) {
          run.toolName = message.toolName;
          if (message.toolName === "mcp_call") run.args = asCalled.get(message.toolCallId) ?? run.args;
          run.summary = summarizeToolCall(message.toolName, run.args);
        }
        run.status = message.isError ? "error" : "done";
        run.result = {
          content: message.content,
          details: message.details,
          isError: message.isError,
        };
        run.startedAt = message.startedAt ?? run.startedAt;
        run.finishedAt = message.timestamp;
      }
    }
  }

  /*
   * A call with no result did not survive; it is not still running.
   *
   * Tool state is rebuilt from the log, and a call is only marked finished when its result is
   * written. Quit the app — or lose the renderer — while a command is running and no result is
   * ever recorded, so re-opening that session showed a spinner counting up from a process that
   * stopped existing minutes ago. Nine minutes on a `git status` is not a slow command, it is a
   * lie about what is happening.
   *
   * Only when the turn itself has settled: a session that is genuinely mid-turn in the
   * background has calls that legitimately have no result yet.
   *
   * The log alone cannot tell a settled turn from one that is running a command. The reply that
   * asked for the command is final (`toolUse`) the moment it has asked, and the result is written
   * when the command ends — so a busy conversation read back from the main process looked settled,
   * and its running command came back drawn as failed: on focusing a split screen again, on warming
   * one beside another, a red cross that stayed until the command finished. `running` is the main
   * process saying the turn is not over; the calls of the reply being executed are then still
   * running, and keep the record this window already had — when they started, what they printed.
   */
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "pending") return runs;
  const executing = new Set(
    running && lastAssistant?.role === "assistant" && lastAssistant.stopReason === "toolUse"
      ? lastAssistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
      : [],
  );
  for (const run of Object.values(runs)) {
    if (run.status !== "running") continue;
    if (executing.has(run.toolCallId)) {
      const kept = live[run.toolCallId];
      if (kept) runs[run.toolCallId] = kept;
      continue;
    }
    run.status = "error";
    run.result = { content: [{ type: "text", text: translate("derive.noResult") }], isError: true };
    run.finishedAt = run.startedAt;
  }

  return runs;
}
