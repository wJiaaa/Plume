/**
 * 一条回复处理完以后，还要不要再来一轮。
 *
 * 出错、中断、步数上限和插话由循环自己处理；回复正常落定之后，让循环续跑、追问或停下的规则都登记在
 * 这两张表里，表里的顺序就是规则之间的优先级（比如 Stop 钩子排在清单收尾前面，钩子看到的才是真正的
 * 回答）。循环只按表问下去；加一条规则是写一个函数、在 `turnChecks` 里登记一行。每条线的值和来历见
 * docs/architecture/agent-loop.md 的「停止与续跑总表」。
 */

import { awaitingEmptyNudge, AwaitWatch } from "./awaiting.ts";
import { originalInView, REPEAT_WARN, repeatHint, repeatNotice, type RepetitionWatch } from "./repetition.ts";
import type { PlanWatch } from "./plan-watch.ts";
import { isArgumentsLost } from "./tool-run.ts";
import type { AgentControlContext, AgentRunResult } from "./run-config.ts";
import type { AgentEventSink } from "./events.ts";
import type { AssistantContent, AssistantMessage, Message, ToolResultMessage } from "../types.ts";

/** Empty-response retries per run; tool calls must not replenish this budget. */
const MAX_NUDGES = 3;
/** Consecutive replies cut off by the output limit before the run stops and says so. */
const MAX_TRUNCATED_REPLIES = 3;
/** 连着这么多轮并行调用的参数都在路上丢光，说明告诉它「一次一个」也绕不开，见 `lostArguments`。 */
const MAX_LOST_ROUNDS = 3;
const CONTINUE_AFTER_LENGTH = "（自动继续）上一条回复达到了输出长度上限，在中途被截断。请从断开的地方直接接着写，不要重复已经写出的内容。";
const EMPTY_REPLY_NUDGE = "（自动继续）上一条回复没有正文。请给出回答；如果需要用户补充信息，请直接提问并等待回复。";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
export type Ending = { reason: AgentRunResult["reason"]; error?: string };

/** `say`：以用户角色说这句话，再来一轮；`end`：收场；`undefined`：这条规则没有意见。 */
type Verdict = { say: Message } | { end: Ending } | undefined;

/** 一条只有正文的回复，插话已经确认没有。 */
export interface ProseTurn {
	assistant: AssistantMessage;
	/** 还没到步数上限。到了就不该再要一轮。 */
	turnsLeft: boolean;
	/** 这次运行产生的全部消息，含这条回复。 */
	produced: readonly Message[];
}

/** 一条带工具调用的回复，工具已经跑完、结果已经进了历史。 */
interface ToolTurn {
	assistant: AssistantMessage;
	toolCalls: ToolCall[];
	toolResults: ToolResultMessage[];
	/** 模型眼里的整段历史：换掉重复结果前要确认原文还在眼前。 */
	messages: readonly Message[];
}

type Check<T> = (turn: T) => Verdict | Promise<Verdict>;

/** 两张表怎么问见 `askAfterProse` 与 `askAfterTools`。 */
export interface TurnChecks {
	afterProse: Check<ProseTurn>[];
	afterTools: Check<ToolTurn>[];
}

type Inject = (message: Message) => Promise<void>;

/**
 * 回复只有正文，本该收场：第一条有意见的规则说了算，后面的不再问——它们的计数只算真正问到的那次。
 * 返回 `undefined` 是再来一轮。
 */
export async function askAfterProse(checks: TurnChecks, turn: ProseTurn, inject: Inject): Promise<Ending | undefined> {
	for (const check of checks.afterProse) {
		const verdict = await check(turn);
		if (!verdict) continue;
		if ("end" in verdict) return verdict.end;
		await inject(verdict.say);
		return undefined;
	}
	return { reason: "done" };
}

/**
 * 跑完了工具，本该接着做：`end` 立刻收场；`say` 照说，后面的照问——按轮计数的规则要看到每一轮。
 * 返回 `undefined` 是再来一轮。
 */
export async function askAfterTools(checks: TurnChecks, turn: ToolTurn, inject: Inject): Promise<Ending | undefined> {
	for (const check of checks.afterTools) {
		const verdict = await check(turn);
		if (!verdict) continue;
		if ("end" in verdict) return verdict.end;
		await inject(verdict.say);
	}
	return undefined;
}

/** 一次运行一份：计数跟着运行走，`repetition` 由调用方给，跨整条续跑链共用。 */
export function turnChecks(control: AgentControlContext, emit: AgentEventSink, plan: PlanWatch, repetition: RepetitionWatch): TurnChecks {
	const limit = outputLimit(emit);
	const awaiting = new AwaitWatch(control.awaiting ?? (() => []));
	const stop = stopHook(control);
	return {
		afterProse: [
			limit.prose,
			({ assistant }) => (plan.silent(assistant) ? { end: { reason: "done" } } : undefined),
			emptyReply(awaiting, stop.answering),
			stop.check,
			// 子代理还没回来时那一项本来就该挂着；问了，它就把还没等到的结论提前写出来。
			({ turnsLeft }) => (awaiting.pending().length > 0 ? undefined : say(plan.closing(turnsLeft))),
		],
		afterTools: [
			delivered,
			({ toolCalls, toolResults }) => (plan.settled(toolCalls, toolResults) ? { end: { reason: "done" } } : undefined),
			limit.tools,
			lostArguments(),
			repeats(repetition),
			({ assistant, toolCalls }) => say(plan.progress(assistant, toolCalls)),
			() => say(awaiting.afterTools()),
		],
	};
}

/**
 * The runtime speaking in the user role — the only role a model takes instructions in — marked so
 * the window does not draw it in the person's bubble as something they typed.
 */
function synthetic(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now(), synthetic: true };
}

function say(text: string | undefined): Verdict {
	return text === undefined ? undefined : { say: synthetic(text) };
}

/**
 * 撞上输出上限，两条路共用一个连续计数：一条没被截断的回复，不管带不带工具，都清零。
 *
 * Cut off by the output limit is not finished: let it continue from the break, a bounded number of
 * times. Tool calls with cut-off arguments were already failed when the tools ran; here they are
 * only counted.
 */
function outputLimit(emit: AgentEventSink): { prose: Check<ProseTurn>; tools: Check<ToolTurn> } {
	let streak = 0;
	return {
		prose: async ({ assistant }) => {
			if (assistant.stopReason !== "length") {
				streak = 0;
				return undefined;
			}
			streak += 1;
			/*
			 * 步数用完也照说这一句，不看 `turnsLeft`：截断的回答没写完，这一轮该由循环在下一步顶上按
			 * `max_turns` 收场，续跑链认的是它。从前步数用完时不说、往下问，后面的规则都没意见，于是一条
			 * 写到一半的回答按 `done` 收场、续跑链不接，还先报了一句并不属实的「连续多次……已停下」。
			 * 说出来也让续跑那次请求以这句话结尾，而不是以半截回复结尾——带思考的请求不接受那种续写。
			 */
			if (streak <= MAX_TRUNCATED_REPLIES) return say(CONTINUE_AFTER_LENGTH);
			await emit({ type: "notice", level: "warn", message: "回复连续多次达到输出长度上限，已停下。最后一段回答可能不完整。", code: "output-limit" });
			// 说了「已停下」就真停：交给后面的规则，只有思考、正文为空的那种截断会被 `emptyReply` 当成空回复再催三次。
			return { end: { reason: "done" } };
		},
		tools: ({ assistant }) => {
			const truncated = assistant.stopReason === "length";
			streak = truncated ? streak + 1 : 0;
			if (!truncated || streak <= MAX_TRUNCATED_REPLIES) return undefined;
			return { end: { reason: "error", error: "回复连续多次在工具参数写到一半时达到输出长度上限，已停下。可以让它把内容拆小，或换一个输出上限更大的模型。" } };
		},
	};
}

/**
 * A checklist cannot tell a question from abandoned work. Text yields to the person; only an
 * actually empty response earns a bounded retry.
 */
function emptyReply(awaiting: AwaitWatch, answeringStop: (produced: readonly Message[]) => boolean): Check<ProseTurn> {
	let nudges = 0;
	return ({ assistant, produced }) => {
		const saidNothing = assistant.content.every((part) => part.type !== "text" || !part.text.trim());
		// 回 Stop 钩子那句话时一个字没写，是「没有要补的」：计划模式那句提醒就要它这样收尾，催了它只会补一句「无需计划」。
		if (!saidNothing || answeringStop(produced)) return undefined;
		if (nudges >= MAX_NUDGES) return { end: { reason: "error", error: "模型连续返回空回复，请重试或更换模型。" } };
		nudges += 1;
		// 「请给出回答」在等子代理时是在要结论：`1155850f` 被这句逼出了一句「设计方向已明确」，最后一路还没回来。
		const pending = awaiting.pending();
		return say(pending.length > 0 ? awaitingEmptyNudge(pending) : EMPTY_REPLY_NUDGE);
	};
}

/** `answering`：这条回复紧跟在钩子上一次说的话后面，是在回答它。 */
function stopHook(control: AgentControlContext): { check: Check<ProseTurn>; answering: (produced: readonly Message[]) => boolean } {
	let said: Message | undefined;
	return {
		check: async ({ assistant, produced }) => {
			if (!control.onStop || control.signal?.aborted) return undefined;
			const responseText = assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
			const toolCallCount = produced.filter((message) => message.role === "toolResult").length;
			const resume = await control.onStop({ responseText, toolCallCount }).catch(() => undefined);
			if (!resume || control.signal?.aborted) return undefined;
			said = resume;
			return { say: resume };
		},
		answering: (produced) => said !== undefined && produced.at(-2) === said,
	};
}

/**
 * A tool said "that's it" (`yield`): the result is already in `state`, and nobody reads another
 * reply. Asking anyway once retried an empty answer 222 times over 34 minutes.
 */
const delivered: Check<ToolTurn> = ({ toolResults }) =>
	toolResults.some((result) => result.terminate === true) ? { end: { reason: "done" } } : undefined;

/**
 * 并行调用的参数连着几轮在路上丢光（`tool-run.ts` 的 `argumentsLost`）。
 *
 * 结果里已经说了原因和绕法：一次只调一个。说过还这样，要么模型不听，要么这个服务商单个调用也丢——
 * 哪一种再跑下去都只是烧钱，所以停下，把换模型的决定交给人。不用 `stalled`：界面上那句「同一个调用
 * 反复得到相同结果」说的不是这回事。
 */
function lostArguments(): Check<ToolTurn> {
	let streak = 0;
	return ({ toolResults }) => {
		streak = toolResults.some(isArgumentsLost) ? streak + 1 : 0;
		if (streak < MAX_LOST_ROUNDS) return undefined;
		return { end: { reason: "error", error: `模型服务连续 ${MAX_LOST_ROUNDS} 轮丢失了工具调用的参数，请更换模型或服务商后重试。` } };
	};
}

/**
 * Same call, same arguments, same answer — again. Correct first, stop only when correction failed.
 *
 * From the third identical answer on, the model sees "this is the Nth time" instead of the same
 * text again. Replaced after commit, so the log keeps the original; the cost is one prefix break
 * after a restart. See docs/architecture/agent-loop.md.
 */
function repeats(watch: RepetitionWatch): Check<ToolTurn> {
	return ({ toolCalls, toolResults, messages }) => {
		/*
		 * 参数丢光的那一轮不算。它的每条结果都一样、参数都是 `{}`，照算的话第一轮就够到警告线：那句「同样
		 * 的参数问了多次」会盖掉结果里已经说中的原因，还把那条原文换成「这是第 N 次」。是否该停由
		 * `lostArguments` 管。
		 */
		if (toolResults.some(isArgumentsLost)) return undefined;
		const { warn: repeated, kind, repeats: seenCounts } = watch.observe(toolCalls, toolResults);
		if (watch.exhausted()) return { end: { reason: "stalled" } };

		for (const [index, seen] of seenCounts.entries()) {
			if (seen < REPEAT_WARN) continue;
			const result = toolResults[index];
			if (!result) continue;
			// Pruning may have replaced the earlier copies with pointers; then this one is the original.
			if (!originalInView(messages, toolCalls[index], result)) continue;
			result.content = [{ type: "text", text: repeatNotice(seen, toolCalls[index].name) }];
		}
		return repeated ? say(repeatHint(kind, repeated)) : undefined;
	};
}
