/**
 * Keeping a long conversation inside a context window.
 *
 * Three mechanisms, cheapest first, and each one is a different answer to a different problem:
 *
 *   1. `prune.ts` cuts oversized tool results. No model, no request, and it alone often suffices —
 *      a session that ran three greps over a large repository is mostly those three results.
 *   2. This file replaces the older half of the history with a structured summary, and hands the
 *      boundary back so the caller can *store* it.
 *   3. `recall` (a tool) reads the original log back on demand, so nothing summarised is actually
 *      lost — only moved out of the window until it is asked for.
 *
 * The third is what makes the second safe to be aggressive about. A summary is lossy by
 * construction; a summary next to a searchable transcript is not, and that is the difference
 * between compacting to a third of the window and compacting to a tenth of it.
 *
 * The second is what makes any of it durable. Compaction used to return a shorter array to the
 * running loop and nothing more — so the next prompt rebuilt its history from the log, got every
 * original message back, and compacted again from scratch. The conversation could never be smaller
 * than the log, and the log only grows. That is the whole of "stuck at 80%, compacting every turn":
 * not an arithmetic error in what to cut, but a result that was thrown away as soon as it was made.
 * So compaction now returns what was summarised and where the boundary fell, and the session
 * writes both down.
 */

import type { Compaction, CompactionLineage, CompactionObserver, CompactionVia } from "../../types/compaction.ts";
import { streamAssistant } from "../../ai/index.ts";
import { dropUneventful, FRESH_RESULT_MAX_CHARS, pruneToolResults, type ArtifactSink } from "../../agent/prune.ts";
import { dropStaleResults } from "./stale-results.ts";
import { estimateTokens, measureTotal } from "../../tokens.ts";
import { taskContextFromHistory } from "./task-context.ts";
import type { Message, ModelConfig, ProviderConfig, RequestPrefix } from "../../types.ts";
import { forkable, forkSummary } from "./compaction-fork.ts";
import { droppedMessage, filesSeen, lastRequest, summaryMessages } from "./compaction-head.ts";
import { fallbackSummary, summarize } from "./compaction-summary.ts";
import { compactionBudget, KEEP_MIN, type CompactionBudget } from "./compaction-budget.ts";

/**
 * Everything a compaction decision needs, as one object.
 *
 * It is an object rather than a parameter list because the parameter list is what went wrong. The
 * seam used to take four arguments while the direct call took nine, so `compactWith` silently
 * dropped five of them the moment a host bound a strategy — and the desktop bound one at the time. What the
 * desktop lost was not cosmetic: `overhead` is the system prompt and the tool schemas, and a
 * budget computed without them lands over the line it was aiming for and then compacts on every
 * single turn; `artifacts` is what makes the `artifact://` address in a pruned placeholder real.
 * Both were off on the only host that ships.
 *
 * A field added here now reaches every implementation or fails to compile.
 */
export interface CompactionRequest {
	observer?: CompactionObserver;
	messages: Message[];
	model: ModelConfig;
	provider: ProviderConfig;
	/**
	 * `streamFn` is the same seam the loop uses to reach the model.
	 *
	 * Passed through rather than reached for, because summarising is itself a model call: a host
	 * that replaced how requests are made must have replaced this one too, or a session with a
	 * stubbed provider quietly dials out when it runs out of room.
	 *
	 * It is also what lets compaction be exercised without a model. Compaction is hard to observe in
	 * the wild — it happens once, deep in a long run, and the evidence is that a number went down.
	 * Being able to drive it directly is the only way to know the cut lands where it should.
	 */
	streamFn?: typeof streamAssistant;
	/**
	 * What the request carries besides the conversation: the system prompt and every tool schema.
	 *
	 * Passed in because it is fixed while the conversation is not. A budget that treats the two as
	 * one shrinks the prompt and the schemas on paper whenever the conversation is cut — and they
	 * are sent in full every time, so the result lands above the line it was aiming for.
	 */
	overhead?: number;
	/**
	 * Compact now, whatever the conversation currently weighs — what `/compact` sets.
	 *
	 * Someone who has just finished one piece of work and is about to start another knows something
	 * the threshold cannot: that the last two hours are done with, and carrying them into the next
	 * thing is what will make it drift. Waiting for the automatic line would summarise the new work along with the old.
	 */
	force?: boolean;
	/**
	 * Where cut-out originals are kept so `artifact://` can fetch them back.
	 *
	 * Optional: without it pruning behaves as it always did, and what is cut is gone. With it, the
	 * placeholder's "the full result stays in the session" is true for the model for the first time —
	 * it cannot read the transcript, but it can read an address.
	 */
	artifacts?: ArtifactSink;
	/** `/compact <instructions>`, and the signal that cancels it. */
	manual?: { instructions?: string; signal?: AbortSignal };
	/**
	 * 从哪一次请求分叉出摘要请求（`runtime/compaction/compaction-fork.ts`）。不给就只有独立的摘要请求——
	 * 超长恢复不给，因为完整历史本来就放不下。
	 */
	lineage?: CompactionLineage;
}

/**
 * What to do when the conversation no longer fits.
 *
 * Summarising the middle is one answer, not the answer: dropping tool output, spilling to a file
 * the agent can grep, or asking the user are all reasonable, and which is right depends on the
 * work. Returning `null` means "nothing needed", so a strategy also decides when to act.
 */
export interface CompactionStrategy {
	compact(request: CompactionRequest): Promise<Compaction | null>;
}

/**
 * Which strategy is in force.
 *
 * Unbound in both hosts, where the built-in answer is the right one. Callers go through
 * `compactWith` so that replacing the strategy is one `useCompaction` call, not an edit to the
 * loop that runs out of room — the sub-agent and overflow tests do exactly that.
 */
let strategy: CompactionStrategy | null = null;

export function useCompaction(next: CompactionStrategy | null): void {
	strategy = next;
}

/**
 * The one way history gets shortened.
 *
 * Both paths come through here — the loop running out of room, and a person typing `/compact` —
 * and both hand over the whole request. They did not always: this took seven positional arguments
 * and forwarded four of them to the strategy, so a host that bound one (the desktop does) lost
 * the overhead and the artifact sink without a word. The request is an
 * object now so that adding to it cannot leave a caller silently short — and the built-in policy
 * takes the same object, so there is no second place that spells the fields out one by one.
 */
export function compactWith(request: CompactionRequest): Promise<Compaction | null> {
	if (strategy) return strategy.compact(request);
	return compactIfNeeded(request);
}

/**
 * The built-in policy. What each field of the request is for is documented on `CompactionRequest`;
 * the defaults are applied here and only here, so no caller has a copy of them to drift.
 */
export async function compactIfNeeded(request: CompactionRequest): Promise<Compaction | null> {
	const { model, provider, artifacts, manual, observer } = request;
	const streamFn = request.streamFn ?? streamAssistant;
	const overhead = request.overhead ?? 0;
	const force = request.force ?? false;
	let messages = request.messages;
	/*
	 * The provider's own count, not our estimate of it.
	 *
	 * `estimateTokens` is characters over 3.5: fair over English prose and code, badly low on CJK
	 * and on dense JSON. Both errors point the same way, so a conversation sitting at 200.7k of a
	 * 200k window reported something in the eighties and never crossed this line.
	 *
	 * `measureTotal` is also what the context panel shows, so what triggers compaction is the same
	 * figure the user is watching fill up. It falls back to the estimate before the first reply has
	 * landed, which is the only point at which there is nothing measured to use.
	 */
	const measured = measureTotal(messages);
	const originalMessages = messages;
	// Before the first measured reply (and after compaction), schemas and instructions still count.
	const used = measured.tokens + (measured.measured ? 0 : overhead);
	const budget = compactionBudget(model.contextWindow, overhead, force ? Math.max(0, used - overhead) : undefined);
	if (!force && used < budget.trigger) return null;

	/*
	 * Cut the oversized tool results first, and see whether that was enough.
	 *
	 * Cheapest thing first, by a wide margin: cutting is string work, summarising is a model call
	 * that is slow, billed, and least reliable exactly when the window is tight.
	 */
	/*
	 * Results with nothing in them go first, before anything with content is touched.
	 *
	 * A search that matched nothing and a listing of an empty directory take up room and answer no
	 * question that will be asked again. Emptying them is free in a way that cutting a real result
	 * is not — nothing is lost, so there is no judgement about what the model might need later.
	 *
	 * 被后来的观察覆盖的结果也只在这里清：会话中途不改写已经发出去的内容，压缩本来就要重写前缀。
	 */
	const tidied = dropUneventful(messages);
	const stale = dropStaleResults(tidied);
	/*
	 * 模型还没看过的新结果（最后一条助手消息之后）只剪炸开的那种，和发送路径第一次发出前的那条线相同。
	 * `read` 把输出控制在这条线以内，并把返回的行记成读过；这里照常剪到 8k 的话，它记下的又
	 * 多于模型看到的，`edit` 会放行没见过的行。
	 */
	const unseenFrom = stale.findLastIndex((message) => message.role === "assistant") + 1;
	const seenPart = stale.slice(0, unseenFrom);
	const unseenPart = stale.slice(unseenFrom);
	const seenPruned = pruneToolResults(seenPart, undefined, artifacts);
	const unseenPruned = pruneToolResults(unseenPart, FRESH_RESULT_MAX_CHARS, artifacts);
	const pruned = seenPruned === seenPart && unseenPruned === unseenPart ? stale : [...seenPruned, ...unseenPruned];
	if (pruned !== messages) {
		/*
		 * Priced by calibrating the estimate on the view that was measured, then applying that same
		 * calibration to the cut copy. Dividing the measurement by an estimate of the cut copy instead
		 * gives back `used` for any cut at all, so this path could never be taken with a measured
		 * usage: a history estimated at 8.6k tokens cut to 1.5k still asked for a summary.
		 *
		 * `messages` stands in for what the last request sent. Every automatic caller is the loop,
		 * which passes the array it sent — `AgedToolPruner` puts back the views it sent before, so a
		 * result it already cut arrives cut and saves nothing twice — plus what arrived since. The
		 * approximation errs cautious when the pruner cut more this turn (the estimate is below what
		 * was measured, the calibration above the truth). Views an earlier compaction adopted survive
		 * a restart (`SessionLog.restoredViews`), so a result that went out cut arrives cut then too.
		 * `/compact` passes the log in full, but it forces a summary and never takes this path.
		 */
		const sent = estimateTokens(messages);
		const calibration = measured.measured && sent > 0 ? Math.max(0, used - overhead) / sent : 1;
		const next = estimateTokens(pruned) * calibration;
		/*
		 * And it has to clear the line by a margin, because both sides of that product are estimates
		 * and being wrong in the eager direction sends a turn that does not fit — which comes back
		 * the same size, with nothing left to cut.
		 */
		/*
		 * Not when compaction was asked for by name. Cutting tool output is the cheap half of this
		 * and it leaves the conversation itself untouched — which is precisely what someone typing
		 * `/compact` wants dealt with.
		 */
		if (!force && next < budget.settled) {
			return { messages: pruned, summary: "" };
		}
		// Not enough on its own, but everything below now works on the smaller conversation.
		messages = pruned;
	}

	// Too short to have a past worth summarising, whatever it weighs.
	if (messages.length <= KEEP_MIN + 2) {
		return pruned !== originalMessages ? { messages: pruned, summary: "" } : null;
	}

	/*
	 * The estimate corrected by however wrong it was overall, so the cut lands where it is meant to.
	 *
	 * The threshold above uses the measured total, but the budget below is spent one message at a
	 * time and there is no per-message figure from the provider to spend it against. The correction
	 * applies to the messages alone, never to the overhead: `used` covers prompt, schemas and
	 * history, `raw` estimates only the history, and dividing one by the other would bake a
	 * constant into a variable.
	 *
	 * Divided by the cut copy, not by what was sent: `/compact` hands over the log in full, which can
	 * be many times what was measured, and a scale that runs low here lets the summary request and
	 * the kept tail outgrow the window. Over the cut copy it can only run high, the safe way.
	 */
	const raw = estimateTokens(messages);
	const conversation = Math.max(0, used - overhead);
	const scale = measured.measured && raw > 0 ? conversation / raw : 1;

	// Keep recent turns until their budget is spent, then cut — never between an assistant
	// message and the tool results answering it, which both APIs reject.
	// A manual request retires completed work even when it fits comfortably in a large window (`budget.keep`).
	let cut = messages.length;
	let kept = 0;
	while (cut > 1) {
		const next = estimateTokens([messages[cut - 1]]) * scale;
		if (messages.length - cut >= KEEP_MIN && kept + next > budget.keep) break;
		kept += next;
		cut--;
	}
	while (cut < messages.length && messages[cut].role === "toolResult") cut++;
	if (cut <= 1) return null;

	const older = messages.slice(0, cut);
	const recent = messages.slice(cut);

	/*
	 * 先试从主请求分叉（`compaction-fork.ts`）：同一个前缀，缓存照常命中，看到的是没剪过的完整历史。
	 * 它摘要的是整段，包括下面原样保留的尾部——那几条说两遍，比整段历史按原价重读一遍便宜得多。
	 * 没有分叉起点、换了模型、缓存凉了、放不下、或者它没交回一份摘要，就退回独立请求。
	 */
	let summary: string | null = null;
	let via: CompactionVia = "independent";
	let prefix: RequestPrefix | undefined;
	if (forkable(request.lineage, provider, model)) {
		await observer?.progress({ phase: "summarizing", provider: provider.id, model: model.id });
		const forked = await forkSummary(request.lineage, provider, model, streamFn, {
			instructions: force ? manual?.instructions : undefined,
			signal: manual?.signal ?? observer?.signal,
			observer,
		});
		if (manual?.signal?.aborted) throw new Error("压缩已取消。");
		if (observer?.signal?.aborted) return null;
		prefix = forked.prefix;
		if (forked.summary) {
			summary = forked.summary;
			via = "fork";
		}
	}
	if (!summary) {
		await observer?.progress({ phase: "summarizing", provider: provider.id, model: model.id });
		summary = await summarize(older, model, provider, streamFn, force ? manual ?? {} : undefined, observer, scale);
		if (observer?.signal?.aborted) return null;
	}
	if (!summary) {
		summary = fallbackSummary(older);
		via = "fallback";
	}
	const tagged = (result: Compaction | null): Compaction | null => (result && prefix ? { ...result, prefix } : result);
	if (!summary) return tagged(dropOldest(messages, model, budget, scale));
	const text = summary;

	/*
	 * Keep dropping the oldest of what was kept until the result actually fits.
	 *
	 * Shrinking is not the requirement; fitting is. A window at 277k that compacts to 250k has been
	 * compacted and still cannot be sent, and the next turn arrives at a conversation that is over
	 * the line with nothing left to try.
	 *
	 * The summary is written once — that is the part that costs a request — and what varies
	 * afterwards is how much of the recent tail is kept beside it, which costs nothing to
	 * reconsider. Tool results are dropped with the call they answer, since sending one without the
	 * other is rejected outright.
	 *
	 * Trimmed to `settled`, not to where dropping aims: the tail is the current work its budget chose,
	 * and beside a summary it normally lands far below the line anyway. Aiming lower only hurt
	 * windows where the prompt and schemas are a large share — see `SAFE_AFTER`.
	 */
	const target = budget.settled;
	const scaled = (list: Message[]) => estimateTokens(list) * scale;
	let tail = recent;
	const withHead = () => {
		// Tail trimming can retire another request or plan update; keep its facts outside the summary too.
		const retired = messages.slice(0, messages.length - tail.length);
		return [...summaryMessages(text, lastRequest(retired), provider, model, filesSeen(retired), taskContextFromHistory(retired)), ...tail];
	};
	let compacted = withHead();
	while (scaled(compacted) > target && tail.length > 1) {
		let drop = 1;
		while (drop < tail.length && tail[drop].role === "toolResult") drop++;
		tail = tail.slice(drop);
		compacted = withHead();
	}

	/*
	 * A summary that did not shrink anything is not worth the message it arrived in. Compared in
	 * one unit — the scaled estimate — because comparing an estimate against a measured total lets
	 * the estimator's own error decide the answer.
	 */
	let result: Compaction | null = scaled(compacted) < scaled(messages) ? { messages: compacted, summary: text, kept: tail.length, via } : null;

	/*
	 * 尾部删光了仍在触发线以上，是摘要本身太大——多半是兜底摘要带着整段历史请求。先试按条丢弃：落到线下
	 * 就用它。都落不到的，取两份里小的那份，但它必须在窗口以内——交回一份发不出去的历史当作压缩成功，
	 * 下一轮只会原样超长。比的是触发线而不是 `target`：后者是想落到的位置，落不到那里但已在线下的结果
	 * 照样能用。光开销就占满触发线时什么历史都放不下，丢弃也救不了，不走这一步。
	 */
	const { room } = budget;
	if (room > 0 && scaled(compacted) >= room) {
		const dropped = dropOldest(messages, model, budget, scale);
		if (dropped && scaled(dropped.messages) < room) return tagged(dropped);
		if (dropped && scaled(dropped.messages) < scaled(result?.messages ?? messages)) result = dropped;
		if (result && scaled(result.messages) + overhead > model.contextWindow) return null;
	}
	return tagged(result);
}

/**
 * Getting under the line without a model, for when the summary could not be had.
 *
 * Summarising is a request, and a request fails — the relay is out of credentials, the key is
 * refused, the turn is cancelled. Answering that with `null` reads as "no compaction was needed",
 * and the caller carries on with a conversation that is over the window. The next turn measures the
 * same overfull history, asks for the same summary, and fails the same way.
 *
 * Losing the oldest exchanges outright is worse than summarising them and better than the only
 * alternative, which is a turn that cannot be sent at all. Nothing is destroyed either way: the log
 * keeps everything, and `recall` can still find it.
 *
 * Cuts on whole units. A tool result whose call has been dropped is rejected by both APIs.
 */
function dropOldest(messages: Message[], model: ModelConfig, budget: CompactionBudget, scale: number): Compaction | null {
	const target = budget.dropped;
	const weight = (list: Message[]) => estimateTokens(list) * scale;

	// 预算的是交出去的整份：前面那条说明带着最新请求和任务上下文，中文下能有好几千 token。
	const build = (start: number) => {
		const older = messages.slice(0, start);
		const standing = lastRequest(older) ?? lastRequest(messages);
		return [droppedMessage(standing, taskContextFromHistory(older), model), ...messages.slice(start)];
	};
	if (weight(messages) <= target) return null;
	let start = 0;
	let result: Message[] = messages;
	while (start < messages.length - 1) {
		start++;
		// Never begin on an answer whose question has just been dropped.
		while (start < messages.length && messages[start].role === "toolResult") start++;
		result = build(start);
		if (weight(result) <= target) break;
	}
	if (start === 0) return null;
	// 丢到只剩最后一条仍可能放不下；放不放得下由调用方和摘要结果一起比（见 `compactIfNeeded`）。
	return { messages: result, summary: "", kept: result.length - 1, via: "dropped" };
}
