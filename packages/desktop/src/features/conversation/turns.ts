/**
 * 一轮从哪条消息开始、算到哪、花了多久和多少 token。
 *
 * 转录的页脚、底部运行指示和分行（`grouping.ts` 的 `runs`）问的都是同一件事，换轮的规矩只能有一份：
 * 页脚算的一轮和分行切的一轮不一样，花销就记到了别的回合头上。
 */

import type { AssistantMessage, Message, UserContent } from "@plume/core";
import { freshTokens } from "@plume/core/tokens";
import { CARRY_ON_PROMPTS, todosFrom } from "../../store/derive.ts";

export type TurnStats = {
	/**
	 * 这一轮实际跑了多久。
	 *
	 * 墙上的钟，不是请求耗时之和。模型在想、工具在跑、子代理在跑，对等在外面的人来说都是同一件
	 * 事还没做完——这些时间全在里面。
	 *
	 * 从前这里是把每条回复的 `durationMs` 加起来，那是**只有请求在飞的时候**才走的表：一轮真实
	 * 跑了 13 分 02 秒、其中四次子代理和三次长命令占掉 10 分 48 秒，报出来是 2 分 14 秒。八成
	 * 以上的时间不是被算错，是从来没被算过。而运行中那一行（`RunningIndicator`）读的一直是墙钟，
	 * 所以回合一结束，数字当场从 13 分掉到 2 分——同一个问题的两个答案，差了近六倍。
	 *
	 * 唯一不算进来的是停下来之后那一段：见 `halted`。
	 */
	durationMs: number;
	/**
	 * 其中模型在应答的时间——工具、子代理、中间的调度间隙都不在里面。
	 *
	 * 就是从前 `durationMs` 装的那个数。它没有错，错的是拿它回答「这一轮花了多久」；留在这里，
	 * 是因为「13 分钟里模型只说了 2 分钟」本身是句有用的话，界面把它放进了悬浮说明。
	 */
	requestMs: number;
	/** 纯出字的时间，tok/s 的分母：去掉了排队、首字延迟和连接往返。 */
	sseDurationMs: number;
	outputTokens: number;
	requestCount: number;
	/** 这一轮从哪一条消息开始（人开口的那条）。钩子的运行记录按它和回复的位置归到这一轮。 */
	startIndex: number;
};

/**
 * 一轮的表，边读转录边走。
 *
 * 可变对象，只在这里和 `runs` 里边走边改；要交出去的时候 `snapshot` 出一份不可变的 `TurnStats`——那是要塞进
 * memo 过的行里的东西，原地改的总数 React 有权当作没变过。
 */
type Clock = {
	/** 当前这一段从哪儿起表；`null` 是这一轮还没有任何消息。 */
	from: number | null;
	/** 当前这一段已知走到了哪儿。 */
	to: number;
	/** 之前那些结清了的段加起来有多长。 */
	closedMs: number;
	/**
	 * 上一条回复是停下的（出错，或者被人按停），下一条消息来之前这段不算。
	 *
	 * 这是唯一一处「时间不算数」的地方，也正是 `turn-meter` 那半边 `freeze` 的两个理由：停在那里
	 * 等人回来看一眼的十分钟，是人的时间，不是这一轮的时间。人一开口（或者重试一发出），表重新
	 * 起走，中间那段就这么被跨过去了。
	 */
	halted: boolean;
	requestMs: number;
	sseDurationMs: number;
	outputTokens: number;
	requestCount: number;
	start: number;
};

/** 一轮还什么都没发生。 */
export function newClock(start = 0): Clock {
	return { from: null, to: 0, closedMs: 0, halted: false, requestMs: 0, sseDurationMs: 0, outputTokens: 0, requestCount: 0, start };
}

/**
 * 一条消息在时间轴上占到哪儿为止。
 *
 * 回复的 `timestamp` 是流开始的时刻，加上 `durationMs` 才是它收尾的时刻。工具结果的 `timestamp`
 * 本身就已经是工具跑完的时刻了（它自己的 `durationMs` 是往回算的），再加一次等于把工具时长记两遍。
 */
function endOf(message: Message): number {
	if (message.role === "assistant" && typeof message.durationMs === "number" && message.durationMs > 0) {
		return message.timestamp + message.durationMs;
	}
	return message.timestamp;
}

/**
 * 把一条消息记进表里。
 *
 * 每一条都记，包括画不出行的那些——工具结果、自动继续的那句话。它们占的是真实时间：一条 `task`
 * 跑四分钟，这一轮就是过了四分钟，哪怕这四分钟里一个 token 都没产出。
 *
 * 取 `max` 而不是直接赋值，是因为工具是边流边派的：一条回复的 `toolCall` 块一落地就发出去了，
 * 不等整个流收尾，所以工具结果的时刻可以比派它的那条回复的结束时刻更早。
 */
export function saw(clock: Clock, message: Message): void {
	if (clock.from === null) {
		clock.from = message.timestamp;
		clock.to = message.timestamp;
	} else if (clock.halted) {
		clock.closedMs += Math.max(0, clock.to - clock.from);
		clock.from = message.timestamp;
		clock.to = message.timestamp;
	}
	clock.halted = false;
	clock.to = Math.max(clock.to, endOf(message));
	if (message.role !== "assistant") return;
	const duration = typeof message.durationMs === "number" && message.durationMs > 0 ? message.durationMs : 0;
	const sse = typeof message.sseDurationMs === "number" && message.sseDurationMs > 0 ? message.sseDurationMs : 0;
	const output = typeof message.usage?.output === "number" && message.usage.output > 0 ? message.usage.output : 0;
	clock.requestMs += duration;
	// 没记 sse 的旧消息（磁盘上的老数据）退回整条请求的耗时，至少分母不会是 0。
	clock.sseDurationMs += sse || duration;
	clock.outputTokens += output;
	clock.requestCount += 1;
	// 这几种收场是「停下了」，不是「做完了」——和 `apply-event` 里冻结那块表的条件是同一对。
	// 如果助手回复停下（包括普通的 stop）但上一轮工作计划中仍有未完成的 todo，也暂停时钟，
	// 避免在「继续，把清单里没做完的做完」之前用户等待或阅读的停顿时间被计入耗时。
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		clock.halted = true;
	}
}

/** 两份账说的是不是同一组数：分组每次重做都给一份新的副本，比引用永远不等。 */
export function sameStats(a: TurnStats | undefined, b: TurnStats | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.durationMs === b.durationMs && a.requestMs === b.requestMs && a.sseDurationMs === b.sseDurationMs
		&& a.outputTokens === b.outputTokens && a.requestCount === b.requestCount && a.startIndex === b.startIndex;
}

/** 此刻为止这一轮的账，一份定下来的副本。 */
export function snapshot(clock: Clock): TurnStats {
	const open = clock.from === null ? 0 : Math.max(0, clock.to - clock.from);
	return {
		durationMs: clock.closedMs + open,
		requestMs: clock.requestMs,
		sseDurationMs: clock.sseDurationMs,
		outputTokens: clock.outputTokens,
		requestCount: clock.requestCount,
		startIndex: clock.start,
	};
}

/*
 * The sentences 「继续」 sends live in `store/derive.ts`, next to the stop reasons that choose
 * between them — three places need them now (this file to recognise them, the row under the
 * transcript and the composer's button to send them), and only one of the three is here.
 */

/** The text of a user message, joined. */
function userText(message: Message): string {
	if (message.role !== "user") return "";
	return message.content
		.filter((c): c is Extract<UserContent, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/**
 * Whether this message is picking up a turn that stopped, rather than beginning one.
 *
 * Pressing 继续 after a failure is not a new question — it is the same piece of work, carried on
 * across the break. Counting it as a new turn is what made the timings meaningless: a task that
 * took twenty minutes and was interrupted twice reported the length of its last leg, and the tokens
 * of its last leg, so neither the elapsed time nor the tokens-per-second described anything that
 * actually happened.
 *
 * Only when the reply before it actually stopped. The same sentence typed into a conversation that
 * ended normally is a new instruction and starts a new turn, which is the honest reading of it.
 */
export function resumesTurn(messages: Message[], index: number): boolean {
	const message = messages[index];
	if (!message || message.role !== "user") return false;
	if (!CARRY_ON_PROMPTS.includes(userText(message) as (typeof CARRY_ON_PROMPTS)[number])) return false;
	for (let i = index - 1; i >= 0; i--) {
		const previous = messages[i];
		if (previous.role === "toolResult") continue;
		if (previous.role !== "assistant") return false;
		// The three ways a reply stops short: it failed, it was stopped, or it stopped with unfinished todos.
		// All leave work unfinished and are what 继续 exists to pick up.
		if (previous.stopReason === "error" || previous.stopReason === "aborted") return true;
		const unfinished = todosFrom(messages.slice(0, i + 1)).filter((t) => t.status !== "completed").length > 0;
		if (unfinished) return true;
		return false;
	}
	return false;
}

/**
 * Whether this message is a person starting a turn, rather than the runtime keeping one going.
 *
 * 运行时递来的东西——后台结果、另一个会话的消息——要看它是不是把空闲的会话叫醒了：叫醒的那一轮
 * 是被它开的，时长和花销归它，不该并进人上一次问的那一轮。插在一轮中间的（`steered`）不是：主智能体
 * 一直在干活，把它算成新的一轮，一段没断过的工作就被切成几段。
 */
export function opensTurn(message: Message): boolean {
	if (message.role !== "user") return false;
	if (!message.synthetic) return true;
	return Boolean(message.delivery || message.peer) && !message.steered;
}

/**
 * 这条回复是停在了这里，还是中途歇一下。
 *
 * `pending` 还在写；`toolUse` 交给了工具，后面还有。其余的——正常停、长度上限、出错、被停下——都是停了，
 * 一轮的页脚只会落在这种回复上。
 */
export function settled(stopReason: AssistantMessage["stopReason"]): boolean {
	return stopReason !== "pending" && stopReason !== "toolUse";
}

/**
 * 截至 `endMessageIndex` 的那一轮花了多少。
 *
 * 一轮从人开口的那条消息**本身**起算，不是从它的下一条起算：表要从人按下回车那一刻走，那正是
 * `turn-slice` 给在线那块表定的起点，两边差一点点都会让数字在回合结束的瞬间跳一下。中间的工具
 * 结果和自动继续都属于这一轮，一并记进去。
 */
export function computeTurnStats(messages: Message[], endMessageIndex: number): TurnStats {
	return snapshot(clockThrough(messages, endMessageIndex));
}

/**
 * 还在跑的这一轮，从转录里读出来的那块表：`startedAt` 是停顿扣掉之后的起点（和 `relight` 同一种
 * 算法，`now - startedAt` 就是这一轮跑了多久），`tokens` 是已经收尾的回复花掉的。
 *
 * 给窗口错过了这一轮开头的时候用：`turns` 里那块表是 `agent_start` 点亮的，刷新过窗口、或者这一轮
 * 在窗口打开之前就开始了，就没有它，运行行上的耗时是空的。读的是同一份时钟，所以这一轮结束时印在
 * 回复底下的数字接得上。委派出去的子代理不在转录里，它们的 token 这里数不到。
 */
export function liveTurnMeter(messages: Message[]): { startedAt: number; tokens: number } | null {
	const clock = clockThrough(messages, messages.length - 1);
	if (clock.from === null) return null;
	let tokens = 0;
	for (let i = clock.start; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant" && message.stopReason !== "pending") tokens += freshTokens(message.usage);
	}
	return { startedAt: clock.from - clock.closedMs, tokens };
}

function clockThrough(messages: Message[], endMessageIndex: number): Clock {
	// Walk backwards from endMessageIndex until we hit a real user message or index 0
	let startIndex = 0;
	for (let i = endMessageIndex; i >= 0; i--) {
		// A 继续 after a failure belongs to the turn it is continuing, so the walk goes on past it
		// to the question that actually started the work.
		if (opensTurn(messages[i]) && !resumesTurn(messages, i)) {
			startIndex = i;
			break;
		}
	}

	const clock = newClock(startIndex);
	let currentTodos: ReturnType<typeof todosFrom> = [];
	for (let i = startIndex; i <= endMessageIndex && i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "toolResult" && msg.toolName === "todo_write" && !msg.isError) {
			const details = msg.details as { kind?: string; todos?: ReturnType<typeof todosFrom> } | undefined;
			if (details?.kind === "todo" && Array.isArray(details.todos)) currentTodos = details.todos;
		}
		saw(clock, msg);
		if (msg.role === "assistant" && currentTodos.some((t) => t.status !== "completed")) {
			clock.halted = true;
		}
	}
	return clock;
}
