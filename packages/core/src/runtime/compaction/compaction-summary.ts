/**
 * 写摘要：独立的摘要请求，以及请求失败时的本地兜底整理。
 *
 * 从主请求分叉的那条路在 `compaction-fork.ts`；选哪条路、压到多大在 `compaction.ts`。
 */

import { failureOf, classifyFailure } from "../../ai/failure.ts";
import { streamAssistant } from "../../ai/index.ts";
import { allowance } from "../../agent/prune.ts";
import { estimateTokens, textTokens } from "../../tokens.ts";
import type { CompactionFault, CompactionObserver } from "../../types/compaction.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../../types.ts";
import { FIRST_SUMMARY, focusNote, hasSummary, SUMMARY_SYSTEM, UPDATE_SUMMARY } from "./compaction-prompts.ts";
import { SUMMARY_INPUT, summaryReplyTokens } from "./compaction-budget.ts";
import { replyText } from "../summary/one-shot.ts";

/**
 * 历史一次放不进摘要请求时，最多分几段写。
 *
 * 每多一段就多一次不吃缓存的请求，还要多等一份摘要写完。超长恢复时历史大约一个窗口，摘要请求的
 * 输入占四成，两三段就够；只有 `/compact` 交来一份从没压过的长日志才会碰到这条线，那时每段先各自
 * 截短（`condense`），损失摊在四段里，比整段截到一次请求里小得多。
 */
const MAX_PASSES = 4;

export async function summarize(
	messages: Message[],
	model: ModelConfig,
	provider: ProviderConfig,
	streamFn: typeof streamAssistant,
	manual?: { instructions?: string; signal?: AbortSignal },
	observer?: CompactionObserver,
	/** 实测 usage 与字符估算之比，见 `compactIfNeeded` 里的 `scale`。 */
	scale = 1,
): Promise<string | null> {
	const focus = focusNote(manual?.instructions);
	const instructionFor = (iterative: boolean): Message => ({
		role: "user",
		content: [{ type: "text", text: [iterative ? UPDATE_SUMMARY : FIRST_SUMMARY, focus].filter(Boolean).join("\n\n") }],
		timestamp: Date.now(),
	});
	/*
	 * 预算按实测比例折回字符估算的单位。估算是「字符 / 3.5」，中文和密集 JSON 上会低估到
	 * 三分之一，不校正的话 40% 的预算实际发出去超过整个窗口，摘要请求被拒，退回机械兜底。
	 * 只往保守方向校正：摘要模型可能换了分词器，估算偏高时不据此多塞。
	 *
	 * The history's share is also capped by what the request leaves once the system prompt, the
	 * instruction and the reply it asks for are paid for — on a small summariser window, or beside a
	 * long `/compact` focus, 40% of the window is more than is left. Priced with the longer of the two
	 * instructions, so every pass of a split summary fits the same budget.
	 */
	const inflate = Math.max(1, scale);
	// Room kept for the summary itself, and exactly what the request asks for: sized again from the
	// uncalibrated estimate, it overran what the pre-send check below had priced in.
	const reply = summaryReplyTokens(model);
	const fixed = textTokens(SUMMARY_SYSTEM) + Math.max(estimateTokens([instructionFor(true)]), estimateTokens([instructionFor(false)]));
	const budget = Math.min(model.contextWindow * SUMMARY_INPUT / inflate, (model.contextWindow - reply) / inflate - fixed);
	const ask = (history: Message[], iterative: boolean) =>
		requestSummary(history, instructionFor(iterative), { model, provider, streamFn, manual, observer, inflate, reply, fixed });

	/*
	 * Which instruction to use depends on whether there is already a summary in there.
	 *
	 * Rewriting an existing summary and writing a first one are different jobs, and the difference
	 * is what keeps the beginning of a session alive through its tenth compaction.
	 */
	if (estimateTokens(messages) <= budget) return ask(messages, hasSummary(messages));

	/*
	 * Too long for one request: summarise it in order, a part at a time, each part rewriting the
	 * summary the previous one wrote — the same update a session's second compaction does.
	 *
	 * This used to clip every message to one shared length until the whole history fit a single
	 * request. That kept every step and lost what was in them: on an overflow, where the history is
	 * a full window, each message came down to a few hundred characters, and the error text, the
	 * user's longer instructions and the reasons for a decision went with the middle. Split, each
	 * part is read whole; the summary carries forward between parts.
	 */
	const draftRoom = reply / inflate + estimateTokens([draftMessage("", provider, model)[0]]);
	const parts = splitHistory(messages, Math.max(1, budget - draftRoom));
	let draft: string | null = null;
	for (const part of parts) {
		const history = draft === null ? part : [...draftMessage(draft, provider, model), ...part];
		const written = await ask(history, draft !== null || hasSummary(part));
		if (written === null) return null;
		draft = written;
	}
	return draft;
}

/**
 * 上一段写下的摘要，接在下一段历史前面。格式和压缩头一样以 `<session-summary>` 开头，
 * `UPDATE_SUMMARY` 说的「the conversation above begins with a summary」指的就是它。
 */
function draftMessage(summary: string, provider: ProviderConfig, model: ModelConfig): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: `<session-summary>\n${summary}\n</session-summary>` }], timestamp: 0, synthetic: true },
		{ role: "assistant", content: [{ type: "text", text: "Understood. Continuing from that summary." }], api: provider.api, provider: provider.id, model: model.modelId, usage: emptyUsage(), stopReason: "stop", timestamp: 0 },
	];
}

/**
 * 按顺序切成至多 `MAX_PASSES` 段，每段放进 `budget`。
 *
 * 只在完整的单元之间切：助手消息和回答它的工具结果是一个单元，拆开两种协议都拒收。一个单元自己就
 * 超过预算的（一次读了整个大文件），那一段截短到预算。段数超过上限时把每段放大到「总量 / 上限」，
 * 再各自截短——截短只发生在放不下的那几段里，而不是整段历史一起。
 */
function splitHistory(messages: Message[], budget: number): Message[][] {
	const units: Message[][] = [];
	for (let at = 0; at < messages.length;) {
		let to = at + 1;
		while (to < messages.length && messages[to].role === "toolResult") to++;
		units.push(messages.slice(at, to));
		at = to;
	}
	const weights = units.map((unit) => estimateTokens(unit));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	const pack = (target: number) => {
		const parts: Message[][] = [];
		let current: Message[] = [];
		let weight = 0;
		units.forEach((unit, index) => {
			if (current.length > 0 && weight + weights[index] > target) {
				parts.push(current);
				current = [];
				weight = 0;
			}
			current.push(...unit);
			weight += weights[index];
		});
		if (current.length > 0) parts.push(current);
		return parts;
	};
	let parts = pack(budget);
	if (parts.length > MAX_PASSES) {
		parts = pack(Math.ceil(total / MAX_PASSES));
		// 按单元装箱会多出零头：并进最后一段，由下面的截短收住。
		while (parts.length > MAX_PASSES) parts.splice(-2, 2, [...parts.at(-2)!, ...parts.at(-1)!]);
	}
	return parts.map((part) => condense(part, budget));
}

interface SummaryRequest {
	model: ModelConfig;
	provider: ProviderConfig;
	streamFn: typeof streamAssistant;
	manual?: { instructions?: string; signal?: AbortSignal };
	observer?: CompactionObserver;
	inflate: number;
	reply: number;
	fixed: number;
}

/** 发一次摘要请求。放不下、失败、返回空的，手动压缩抛出说明，自动压缩交回 `null` 走兜底。 */
async function requestSummary(history: Message[], instruction: Message, { model, provider, streamFn, manual, observer, inflate, reply, fixed }: SummaryRequest): Promise<string | null> {
	const context: LlmContext = { systemPrompt: SUMMARY_SYSTEM, messages: [...history, instruction], tools: [] };
	// Provider callbacks are synchronous; serialize their durable records and drain before completion.
	let pending = Promise.resolve();
	let recordError: unknown;
	const faultOf = (failure: ReturnType<typeof failureOf>): CompactionFault => ({ kind: failure.kind, hint: failure.hint });
	const decline = async (fault: CompactionFault) => {
		if (!observer?.signal?.aborted) await observer?.progress({ phase: "fallback", fault });
		return null;
	};
	/*
	 * Checked before sending, not left to the provider to refuse.
	 *
	 * `condense` cannot always reach its budget — images have a fixed weight, and a focus longer than
	 * the window leaves no budget at all. A request known not to fit only spends a retry cycle to be
	 * refused, and on some relays is refused as something that looks retryable.
	 */
	if ((fixed + estimateTokens(history)) * inflate + reply > model.contextWindow) {
		if (manual) throw new Error("摘要请求放不进当前模型的上下文窗口，原上下文保持不变。可以缩短压缩说明后再试。");
		return decline({ kind: "fatal", hint: "check-request" });
	}
	let final: IteratorResult<import("../../types.ts").StreamEvent, AssistantMessage>;
	try {
		const stream = streamFn(provider, model, context, {
			thinking: "off", maxTokens: reply, signal: manual?.signal ?? observer?.signal,
			onRetry: observer ? ({ delayMs, failure }) => {
				pending = pending.then(() => observer.progress({ phase: "retrying", delayMs, fault: failure ? faultOf(failure) : { kind: "unknown" } })).catch((error: unknown) => { recordError = error; });
			} : undefined,
		});
		do { final = await stream.next(); } while (!final.done);
	} catch (cause) {
		await pending;
		if (recordError) throw recordError;
		if (manual) throw cause;
		return decline(faultOf(failureOf(cause)));
	}
	await pending;
	if (recordError) throw recordError;

	const message = final.value;
	if (manual?.signal?.aborted) throw new Error("压缩已取消。");
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		if (manual) throw new Error(message.errorMessage || "摘要生成失败，请检查模型连接后重试。");
		return decline(faultOf(message.failure ?? classifyFailure({ from: "stream", message: message.errorMessage })));
	}
	const text = replyText(message, "\n").trim();
	if (manual && !text) throw new Error("模型返回的摘要为空，原上下文保持不变。");
	return text || decline({ kind: "empty" });
}

/**
 * Shrink a history to fit a token budget by trimming each message rather than dropping any.
 *
 * Dropping whole messages would lose whole steps — the file that was edited, the command that
 * failed — and those are exactly what the summary is for. Every message keeps its head and its
 * tail instead: the head says what was being attempted, the tail says how it turned out, and
 * the middle of a 900-line file is what nobody needs in a summary of the work.
 *
 * The budget holds for the result as a whole. Every message is held to one shared limit, the
 * largest at which the total still fits, so short messages stay whole; inside a message its parts
 * share that limit the same way, so ten long blocks split one allowance instead of taking ten.
 * Only when even `CONDENSE_FLOOR` per message cannot fit — thousands of messages — does a step
 * go, and then the oldest ones after the opening request (see `elide`).
 */
function condense(messages: Message[], budget: number): Message[] {
	if (estimateTokens(messages) <= budget) return messages;
	const fits = (list: Message[], limit: number) => estimateTokens(clipAll(list, limit)) <= budget;
	const kept = fits(messages, CONDENSE_FLOOR) ? messages : elide(messages, budget);

	let low = 0;
	let high = 1;
	for (const message of kept) high = Math.max(high, message.content.reduce((sum, part) => sum + partLength(part), 0));
	// Largest limit that fits; the total only grows with the limit, so bisecting finds it.
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(kept, mid)) low = mid;
		else high = mid - 1;
	}
	return clipAll(kept, low);
}

/**
 * How short a message may be clipped before steps are dropped instead.
 *
 * About a line: enough to say which file and which command. Below that the steps are all still
 * there and none of them says anything, and dropping the oldest is the better loss.
 */
const CONDENSE_FLOOR = 100;

function partLength(part: Message["content"][number]): number {
	if (part.type === "text") return part.text.length;
	if (part.type === "thinking") return part.thinking.length;
	if (part.type === "toolCall") return (part.argumentsText ?? JSON.stringify(part.arguments ?? {})).length;
	return 0;
}

/**
 * Every message held to about `limit` characters, shared out among its parts by `allowance` —
 * thinking gets a third of its share, since it is the least needed. About, because a tool call's
 * strings are clipped one by one and then re-serialised; `condense` measures the result rather
 * than trusting this.
 */
function clipAll(messages: Message[], limit: number): Message[] {
	return messages.map((message) => {
		const share = allowance(message.content.map(partLength), limit);
		return {
			...message,
			content: message.content.map((part) => {
				if (part.type === "text") return { ...part, text: clip(part.text, share) };
				if (part.type === "thinking") return { ...part, thinking: clip(part.thinking, Math.floor(share / 3)) };
				if (part.type === "toolCall") {
					/*
					 * 剪参数对象里的长字符串，再让原文跟着它重新序列化。
					 *
					 * 以前只剪 `argumentsText`、把 `arguments` 置空：OpenAI 两种协议读原文，还看得到路径和
					 * 命令；Anthropic 只读 `arguments`，摘要模型看到的每一次调用都是 `{}`，写不出改过哪个文件。
					 * 两份同源，任何协议读到的都是同一份剪短的参数。
					 */
					const args = clipValues(part.arguments ?? {}, share) as Record<string, unknown>;
					if (args !== part.arguments) return { ...part, arguments: args, argumentsText: JSON.stringify(args) };
					// 参数没解析出来、只剩流式原文（截断 JSON 的抢救稿）时，能剪的只有原文。
					if (Object.keys(args).length === 0 && part.argumentsText && part.argumentsText.length > share) {
						return { ...part, argumentsText: clip(part.argumentsText, share) };
					}
					return part;
				}
				return part;
			}),
		} as Message;
	});
}

/**
 * The history with the oldest steps after its opening removed, until the rest fits at the floor.
 *
 * The opening is the goal — the user's first request, or the previous summary that carries it —
 * and the newest steps are what the summary has to bring up to date, so what goes is the stretch
 * just after the opening. A note stands where it was, so the summariser writes around a gap it
 * knows about instead of reading two distant steps as consecutive. Cut on whole units: a tool
 * result without its call is rejected by both APIs, and so is a call without its result.
 */
function elide(messages: Message[], budget: number): Message[] {
	const unit = (from: number) => {
		let to = from + 1;
		while (to < messages.length && messages[to].role === "toolResult") to++;
		return to;
	};
	const head = unit(0);
	const cost = messages.map((message) => estimateTokens(clipAll([message], CONDENSE_FLOOR)));
	const note = (count: number): Message => ({
		role: "user",
		content: [{ type: "text", text: `[${count} earlier messages omitted here to fit the summary request. They are still in the session log; summarise around the gap and do not guess what was in it.]` }],
		timestamp: messages[head]?.timestamp ?? messages[0].timestamp,
		synthetic: true,
	});
	let rest = cost.slice(head).reduce((sum, value) => sum + value, 0);
	const fixed = cost.slice(0, head).reduce((sum, value) => sum + value, 0) + estimateTokens([note(messages.length)]);
	let from = head;
	while (from < messages.length && fixed + rest > budget) {
		const to = unit(from);
		for (let at = from; at < to; at++) rest -= cost[at];
		from = to;
	}
	if (from === head) return messages;
	return [...messages.slice(0, head), note(from - head), ...messages.slice(from)];
}

/** 参数对象里超长的字符串逐个剪短；没有要剪的就原样返回同一个对象。 */
function clipValues(value: unknown, limit: number): unknown {
	if (typeof value === "string") return clip(value, limit);
	if (Array.isArray(value)) {
		const next = value.map((item) => clipValues(item, limit));
		return next.some((item, i) => item !== value[i]) ? next : value;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		const next = entries.map(([key, item]) => [key, clipValues(item, limit)] as const);
		return next.some(([, item], i) => item !== entries[i][1]) ? Object.fromEntries(next) : value;
	}
	return value;
}

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.7);
	const tail = limit - head;
	const clipped = `${text.slice(0, head)}\n…（省略 ${text.length - limit} 字）…\n${text.slice(text.length - tail)}`;
	// Just over the limit, the marker is longer than what it replaces; a clip must never grow the text.
	return clipped.length < text.length ? clipped : text;
}

/**
 * Deterministic fallback summary when the LLM summarization request fails.
 *
 * Rather than losing all context and instructions completely, this extracts
 * the original user requests, recent actions, and key tool usages mechanically.
 */
export function fallbackSummary(messages: Message[]): string {
	const userPrompts: string[] = [];
	const touchedFiles = new Set<string>();
	const keyActions: string[] = [];

	/*
	 * The previous summary is the only place the original goal still exists.
	 *
	 * By the second compaction the messages that carried the user's opening request are long gone
	 * from this array — the first compaction replaced them with a synthetic message holding the
	 * summary. Reading only non-synthetic user messages therefore finds nothing to put under
	 * `## Goal & Original User Intent`, and the section is simply omitted.
	 *
	 * What that produced, measured: a second compaction whose entire output was 1219 characters of
	 * 「- bash: See commit 3d5d03a」 — a list of commands with no statement of what any of them were
	 * for. Eleven seconds later the model began a 245-call search through its own history trying to
	 * work out what it had been asked to do. It was not confused; it had been handed a summary that
	 * genuinely did not say.
	 *
	 * This path runs precisely when the summariser could not be reached, which is the moment the
	 * conversation can least afford to also lose its purpose. Carrying the previous summary forward
	 * verbatim is the whole fix: it is already in the required format, and it already contains the
	 * goal that a model wrote down while it could still see it.
	 */
	const carried = previousSummary(messages);

	for (const msg of messages) {
		if (msg.role === "user" && !msg.synthetic) {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text.trim())
				.filter(Boolean)
				.join("\n");
			// 和 `lastRequest` 同一个上限：一段贴进来的长日志不该让兜底摘要本身放不下。
			const points = [...text];
			const excerpt = points.length <= 2000 ? text : `${points.slice(0, 2000).join("")}…`;
			if (excerpt && !userPrompts.includes(excerpt)) {
				userPrompts.push(excerpt);
			}
		} else if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "toolCall") {
					const name = part.name;
					const args = (part.arguments ?? {}) as Record<string, unknown>;
					const path = (args.path ?? args.file ?? args.filePath) as string | undefined;
					if (path && typeof path === "string") {
						touchedFiles.add(path);
					}
					if (name === "write" || name === "edit" || name === "bash") {
						const desc = (args.description as string | undefined) ?? (args.command as string | undefined)?.split("\n")[0];
						const line = desc ? `${name}: ${desc}` : path ? `${name} ${path}` : name;
						if (!keyActions.includes(line)) keyActions.push(line);
					}
				}
			}
		}
	}

	const sections: string[] = [];

	/*
	 * The carried summary goes first and keeps its own structure.
	 *
	 * It already opens with `## Goal & Original User Intent` — appending the mechanical sections
	 * after it reads as an update to a handover document, which is what this is, rather than as two
	 * documents stapled together.
	 */
	if (carried) sections.push(carried);

	/*
	 * Only prompts the carried summary does not already account for.
	 *
	 * Without this the goal appears twice on every fallback — once as the previous summary's own
	 * `## Goal` section and once more verbatim underneath it — and a summary that repeats itself
	 * is a summary a reader learns to skim.
	 */
	const fresh = userPrompts.filter((prompt) => !carried?.includes(prompt));
	if (fresh.length > 0) {
		sections.push(
			carried
				? `## Newer User Requests (since the summary above)\n${fresh.map((p) => `- ${p}`).join("\n")}`
				: `## Goal & Original User Intent\n${fresh.map((p) => `- ${p}`).join("\n")}`,
		);
	}

	if (keyActions.length > 0) {
		const recentActions = keyActions.slice(-10);
		sections.push(`## Key Work & Task Progress\n### Recent Key Actions\n${recentActions.map((a) => `- ${a}`).join("\n")}`);
	}

	if (touchedFiles.size > 0) {
		const files = Array.from(touchedFiles).slice(-15);
		sections.push(`## Critical Context\n- Touched files: ${files.join(", ")}`);
	}

	return sections.join("\n\n") || "Previous turns were compacted.";
}

/**
 * The summary a previous compaction left behind, unwrapped from the message carrying it.
 *
 * Matches how `summaryMessages` writes it: a synthetic user message whose text opens with a
 * `<session-summary>` block. The standing request that may follow it is deliberately not picked up
 * here — `compactIfNeeded` recomputes that from the real messages every time, and a stale copy
 * inside the summary would then contradict the fresh one beside it.
 */
function previousSummary(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" || !message.synthetic) continue;
		// 压缩头以 `<session-summary>` 开头；别的合成消息里引用到的同名标签不是上一次的摘要。
		const first = message.content[0];
		const match = first?.type === "text" ? /^<session-summary>\n?([\s\S]*?)\n?<\/session-summary>/.exec(first.text) : null;
		if (match) {
			const text = match[1].trim();
			if (text) return text;
		}
	}
	return null;
}
