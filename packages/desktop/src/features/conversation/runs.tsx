/**
 * Drawing the rows that `grouping.ts` decided on.
 *
 * The grouping itself is plain data and lives next door; what is left here is a card that
 * subscribes to its own tool run and a group that reads the totals across one.
 */

import { memo, useMemo } from "react";
import type { AssistantContent, AssistantMessage } from "@plume/core";
import { PreviewCall, type PreviewInfo } from "../files/index.ts";
import { ToolCard } from "./ToolCard.tsx";
import { useDelegation, useDispatches } from "./DelegationCard.tsx";
import { ReviewSessionRow, SessionSuggestionCard } from "./SessionSuggestionCard.tsx";
import type { ToolRun as ToolRunState } from "../../store/index.ts";
import { useScopedFromMeta, useScopedFromToolRuns, useScopedRunning } from "../../app/session-scope.tsx";
import { useWriteDraft } from "./write-draft.ts";
import type { Dispatch } from "../../lib/dispatches.ts";
import { toolCardFallback } from "./tool-status.ts";
import { sameRun, type Call } from "./grouping.ts";
import type { PageState } from "./preview-pages.ts";
import { describeOne, describePolls, diffOf, pollOutput, polledJob, startedJob } from "./call-words.ts";

/**
 * How many lines a stretch of calls added and removed.
 *
 * Primitives, not the map. A selector returning an object builds a new one every time and so always
 * looks changed; a number is compared by value, so this re-renders when what it shows changes and
 * not when some other card emits a line of output.
 */
export function useDiffTotals(calls: readonly Pick<Call, "block">[], runs?: Record<string, ToolRunState>) {
  const added = useScopedFromToolRuns((toolRuns) => calls.reduce((n, { block }) => n + diffOf((runs ?? toolRuns)[block.id], "added"), 0));
  const removed = useScopedFromToolRuns((toolRuns) => calls.reduce((n, { block }) => n + diffOf((runs ?? toolRuns)[block.id], "removed"), 0));
  return { added, removed };
}

/**
 * One card, subscribed to its own record and nothing else.
 *
 * Tool output streams: a long install or a test run emits `tool_update` many times a second, and
 * each one replaces the whole `toolRuns` map. Anything reading that map re-renders — so with the
 * map read at the top of the transcript, every chunk of output repainted every message in the
 * conversation. In a session with hundreds of messages that is what made scrolling stutter.
 *
 * Reading one entry means Object.is sees no change for the other cards and they stay put.
 */
export function LiveToolCard({
  block,
  stopReason,
  runs,
  dispatch,
  thinking,
  extra,
  page,
  polls,
}: {
  block: Extract<AssistantContent, { type: "toolCall" }>;
  stopReason: AssistantMessage["stopReason"];
  /** A preview's part in checking and publishing a page — see `preview-pages.ts`. */
  page?: PageState;
  /** 这一行代表连着查同一个后台任务的几次 `bash_output`：它们的调用 id，第一个就是 `block`。见 `foldPolls`。 */
  polls?: string[];
  /**
   * Where to read this call's record, for a transcript that is not the main session's.
   *
   * A sub-agent's tool events never reach the app store — `runSubAgent` emits only the messages it
   * produced — so a card left to look itself up there finds nothing, calls itself an error and
   * shows the raw tool name. The sub-agent panel rebuilds the same records from its own transcript
   * and passes them in.
   */
  runs?: Record<string, ToolRunState>;
  /** 这一张要是一次派发，整组对过号之后它是哪一个——见 `DelegationCard`。 */
  dispatch?: Dispatch;
  /** 见 `ToolCard` 的同名属性：这次调用后面跟着的推理。 */
  thinking?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  /*
   * This screen's record of the call. The live slot's `toolRuns` are the focused conversation's, and
   * a call in the conversation beside it is never among them: its card fell back to 「出错」 once the
   * turn ended, and a preview never drew its page.
   */
  const stored = useScopedFromToolRuns((toolRuns) => toolRuns[block.id]);
  const run = runs ? runs[block.id] : stored;
  /*
   * 这一轮还在不在跑，决定没有记录的卡片怎么说话——见 `tool-status.ts`。
   *
   * 子智能体那份转录（传了 `runs`）不看它：那是一段已经结束的记录，而这里读到的 `running` 是
   * 主会话此刻的状态，拿它去判子智能体的旧卡片，会让它们跟着主会话一起转圈。
   */
  const turnRunning = useScopedRunning();
  if (block.name === "task") return <DelegationCard block={block} run={run} stopReason={stopReason} dispatch={dispatch} detached={Boolean(runs)} thinking={thinking} extra={extra} />;
  const plain = <PlainToolCard block={block} run={run} stopReason={stopReason} runs={runs} turnRunning={turnRunning} thinking={thinking} extra={extra} page={page} polls={polls} />;
  // 子智能体的转录里没有这件工具（`sessionOnly`），带着 `runs` 来的照旧是工具行。
  if (block.name === "spawn_session" && !runs) return <SessionSuggestionCard block={block} run={run} stopReason={stopReason} turnRunning={turnRunning} fallback={plain} />;
  if (block.name === "review_session" && !runs) return <ReviewSessionRow block={block} run={run} fallback={plain} />;
  return plain;
}

/** 一次派发：它的脸、派给了谁、在排队还是在跑——见 `DelegationCard.tsx`。 */
function DelegationCard({ thinking, extra, ...props }: Parameters<typeof useDelegation>[0] & { thinking?: React.ReactNode; extra?: React.ReactNode }) {
  return <ToolCard {...useDelegation(props)} thinking={thinking} extra={extra} />;
}

function PlainToolCard({ block, run: own, stopReason, runs, turnRunning, thinking, extra, page, polls }: {
  block: Extract<AssistantContent, { type: "toolCall" }>;
  run?: ToolRunState;
  stopReason: AssistantMessage["stopReason"];
  runs?: Record<string, ToolRunState>;
  turnRunning: boolean;
  thinking?: React.ReactNode;
  extra?: React.ReactNode;
  page?: PageState;
  polls?: string[];
}) {
  /*
   * 查后台任务输出：这一行说的是哪个任务，展开是那条命令和这几次读到的全部输出。状态跟最后一次走——
   * 前几次早答完了，还在等的只会是最后那一次。
   */
  const job = polledJob(block);
  const ids = job ? (polls ?? [block.id]) : undefined;
  const starter = useScopedFromToolRuns((toolRuns) => (job ? startedJob(runs ?? toolRuns, job) : undefined));
  const latest = useScopedFromToolRuns((toolRuns) => (ids ? (runs ?? toolRuns)[ids[ids.length - 1]] : undefined));
  const joined = useScopedFromToolRuns((toolRuns) => (ids ? pollOutput(ids.map((id) => (runs ?? toolRuns)[id])) : undefined));
  const run = ids ? latest : own;
  const result = useMemo(() => (joined !== undefined && run?.result ? { ...run.result, content: [{ type: "text" as const, text: joined }] } : run?.result), [joined, run]);
  const command = starter?.args.command;
  const root = useScopedFromMeta((meta) => meta?.cwd);
  // A checked page is drawn by its check, from the call that published it.
  const publishedBy = page && "publishedBy" in page ? page.publishedBy : undefined;
  const stored = useScopedFromToolRuns((toolRuns) => (publishedBy ? toolRuns[publishedBy] : undefined));
  const publisher = publishedBy ? (runs ? runs[publishedBy] : stored) : undefined;
  const status = run?.status ?? toolCardFallback(stopReason, runs ? false : turnRunning);
  const draft = useWriteDraft(block, !run && !runs);
  // `title`: a preview's, read from its arguments while they are still being written — see `PreviewCall`.
  const card = (title?: string) => (
    <ToolCard
      stateKey={runs ? undefined : `tool-${block.id}`}
      toolName={block.name}
      // 任务 id 是一串 uuid，人读不出东西；展开时摆那条命令本身。
      args={ids && typeof command === "string" ? { command } : block.arguments}
      // The model's own words when it gave some, else core's English summary said the way the turn line says it; see `describeOne`.
      summary={ids ? describePolls(starter?.summary, ids.length) : describeOne(draft.block, run?.summary ?? title, { root })}
      // 没有记录时说什么，以及为什么不能只看这条消息定没定稿：见 `tool-status.ts`。
      status={status}
      result={result}
      startedAt={run?.startedAt}
      aside={draft.lines ? <span className="tabular-nums text-caption">{draft.lines}</span> : undefined}
      thinking={thinking}
      extra={extra}
    />
  );
  /*
   * A preview replaces its own tool card — drawn while it is written, then the page.
   *
   * The card would say "预览已生成" above the thing itself, which is a caption nobody needs —
   * the page is right there, and it is the result.
   */
  if (block.name !== "preview" || (page && "publishing" in page)) return card();
  const preview = ((publishedBy ? publisher : run)?.result?.details as { preview?: PreviewInfo } | undefined)?.preview;
  // Checked and not yet on screen as itself: the draft stays until it is published or the turn ends.
  const waiting = turnRunning && !runs && !preview && Boolean(page && ("waiting" in page || publishedBy));
  return <PreviewCall block={block} preview={preview} live={status === "running"} written={Boolean(run)} waiting={waiting} fallback={card} />;
}


/**
 * Tool calls drawn as cards of their own: a page put up for the reader (`Run.shown`), or the calls
 * inside one reply where the turn line above already says what the turn did (`flat`). Everything
 * else is folded into a `WorkStep` by `turnBlocks`.
 */
function ToolRunCards({ calls, runs, flat }: {
	calls: Call[];
	/** Records for a transcript outside the main session — see `LiveToolCard`. */
	runs?: Record<string, ToolRunState>;
	/** Lay the cards into the surrounding column rather than as a fragment. */
	flat?: boolean;
}) {
	// 这一段里派出去的子智能体：整组一起对号。见 `useDispatches`。
	const dispatches = useDispatches(calls.map(({ block }) => block), runs);
	const byCall = new Map(dispatches.map((one) => [one.callId, one]));
	const cards = calls.map(({ block, stopReason, page }) => (
		<LiveToolCard key={block.id} block={block} stopReason={stopReason} runs={runs} dispatch={byCall.get(block.id)} page={page} />
	));
	// `contents`, so each call sits in the surrounding column's own gap; the attribute keeps the run findable.
	return flat ? <div data-ly-run="done" className="contents">{cards}</div> : <>{cards}</>;
}

/**
 * A settled group of tool calls never changes again: compared by what the group is made of rather
 * than by the array it arrives in, which is rebuilt on every render of the transcript.
 *
 * The comparison itself is `sameRun`, in `grouping.ts`, so that the tests can check the one that
 * actually runs instead of a copy of it. See the note there.
 */
export const ToolRun = memo(ToolRunCards, sameRun);
