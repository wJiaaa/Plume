/**
 * 「还在跑」的那一行怎么说：桌面会话末尾的运行行和手机消息流末尾的那一行，同一份词、同一种读数格式。
 *
 * 从桌面 `lib/thinking-words.ts` 挪过来的：手机要和桌面显示得一样，两份词表各写一份迟早会说两种话。
 * 桌面那边保留原文件做转发，并在那里检查每种 mood 都是 `thinking-orbs` 能画的状态——这里不能依赖
 * 那个画布库（client-runtime 不带 UI）。
 *
 * 词是英文的，而且是刻意的：它挨着 `42s · 63.6k tokens` 这串技术读数，中文短语夹在里面读起来像另一个
 * 声音插话。语气是应用在角落里自言自语，不是向谁汇报进度。
 */

import type { Message } from "@plume/core/client-types";

/**
 * 值得区分的几种等待，和桌面小球能画的九种状态一一对应：
 *
 * - `breathing`  模型在想，什么都没在跑
 * - `listening`  在读
 * - `searching`  grep、glob、ls
 * - `working`    命令在跑
 * - `solving`    一轮测试，要么过要么不过
 * - `connecting` 任何出这台机器的事
 * - `weaving`    排计划，或者子 Agent 在跑
 * - `composing`  写新东西
 * - `shaping`    改已有的东西
 */
export type Mood = "breathing" | "listening" | "searching" | "working" | "solving" | "connecting" | "weaving" | "composing" | "shaping";

const WORDS: Record<Mood, string[]> = {
	listening: ["Reading up", "Skimming", "Digging in", "Getting the lay of it", "Poking around the source"],
	composing: ["Writing", "Drafting", "Putting it down", "Getting it on paper", "Laying down code"],
	shaping: ["Reworking", "Editing", "Reshaping it", "Moving things around", "Knocking it into shape"],
	working: ["Running it", "Kicking it off", "Letting it rip", "Waiting on the shell", "Turning the crank"],
	searching: ["Hunting", "Rummaging", "Casting about", "Following the thread", "Combing through"],
	solving: ["Proving it", "Running the gauntlet", "Making sure", "Putting it through its paces"],
	connecting: ["Having a look", "Loading the page", "Peeking at the web", "Reaching out"],
	weaving: ["Plotting", "Lining it up", "Sketching the order", "Working out the steps"],
	breathing: ["Thinking", "Mulling", "Turning it over", "Chewing on it", "Working it out", "Pondering"],
};

/** 一步耗到这么久，措辞就承认它在磨。 */
const PATIENCE_MS = 45_000;
const LONG_WORDS = ["Still at it", "This one's stubborn", "Taking its time", "Nearly there", "Wrestling with it"];

const BY_TOOL: Record<string, Mood> = {
	read: "listening",
	symbol: "listening",
	write: "composing",
	preview: "composing",
	edit: "shaping",
	bash: "working",
	bash_output: "working",
	glob: "searching",
	grep: "searching",
	ls: "searching",
	todo_write: "weaving",
	task: "weaving",
	web_fetch: "connecting",
	web_search: "connecting",
	browser_act: "connecting",
	// 造一个新东西，和 `write` 同一种；配的那句话在桌面端的运行行里不说（见 `RunningIndicator`）。
	image_generate: "composing",
};

/** 不管从哪个工具进来，其实是一轮测试的命令。 */
const TEST_HINT = /\b(test|jest|vitest|pytest|spec|coverage)\b/i;

/**
 * 它此刻在干什么，按这个顺序问。
 *
 * `retrying` 压过一切：等重连的一轮什么都没在做，小球不该是屏幕上唯一还声称有进展的东西。
 * `writing` 把沉默分成两半——没有工具在跑时，模型要么在推理（还没东西可看），要么在往外写回答
 * （和 `write` 一样是 `composing`）。工具仍然优先：文字在流、工具也在跑时，工具是更具体的事实。
 */
export function moodFor(toolName: string | undefined, summary: string | undefined, retrying = false, writing = false): Mood {
	if (retrying) return "connecting";
	if (summary && TEST_HINT.test(summary)) return "solving";
	if (toolName) return BY_TOOL[toolName] ?? "breathing";
	return writing ? "composing" : "breathing";
}

/**
 * 选一句，不用随机数：按 mood 和一个慢慢走的 tick 取，同一个 mood 不会连着重复同一句，
 * 重绘也不会自己换词——只有时间会。随机会在每一帧换，那正是要避免的闪烁。
 */
export function phraseFor(mood: Mood, tick: number, elapsedMs: number): string {
	if (elapsedMs > PATIENCE_MS) return LONG_WORDS[tick % LONG_WORDS.length]!;
	const pool = WORDS[mood];
	return pool[tick % pool.length]!;
}

/** 这一轮跑了多久：`42s`、`3m 05s`、`1h 12m`。 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}h ${minutes % 60}m`;
	}
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * 一眼读出的 token 数：812、12.3k、4.1M、2.7B。
 *
 * 每一档都留一位小数，因为小数点后那一位才是让人做决定的差别——4.1M 和 4.9M 差了五分之一的账单。
 * 长期项目真能到十亿，没有这一档时数字会写成五位数的百万。桌面的仪表、会话卡、子 Agent 行和手机
 * 的运行行都印这个数，同一个数在两处读法不同就是两个数。
 */
export function formatTokens(count: number): string {
	if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

/**
 * 末尾正在流的这段正文像不像结论。像，运行行就让开：挂在结论底下，字每折一行它就往下跳一行。
 *
 * 流到一半没有确定的信号：只有 OpenAI 的 Responses 会把开场白标成 `commentary`，别的接口不标，
 * 中转网关还会把开场白标成 `final_answer`。所以看长相。2026-10 在本机 1447 条开场白、410 条结论上量过：
 * 开场白中位 58 字、含换行的 1%；结论中位 885 字、含换行的 89%。按「出现换行或超过 150 字」判，
 * 开场白误判 2.8%（工具调用一到就回来），结论多半写到第一段末尾（中位第 73 个字）就判出来——
 * 一行能放六七十个字，判出来之前最多跳一两下。没长到这个地步的短回答本来也跳不了几下。
 */
export const ANSWER_CHARS = 150;

export function looksLikeAnswer(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	const block = last.content[last.content.length - 1];
	// 标了 commentary 的一定是开场白，这一个信号是确定的。
	if (block?.type !== "text" || block.phase === "commentary") return false;
	const text = block.text.trim();
	return text.includes("\n") || text.length > ANSWER_CHARS;
}

/**
 * 末尾在流的是这一轮第一次调工具之前的话：不管它是结论还是开场白，桌面的运行行都让开。
 *
 * `looksLikeAnswer` 不在第一个字就判，运行行就挂在这句话底下，第一个字一来它被推下去一行——逐字显现
 * 的字那时还是透明的，看上去是它跳进了一片空白。2026-10 本机 651 个人开的轮次：纯回答 13.5%，开场白
 * 后调工具 51%。后一种让开之后是开场白写在它原来的位置、调用开始时它在下面淡入回来，原来是跳两次，
 * 所以两种一起让。只管第一次调工具之前：之后每批调用之间的话都让的话，它就围着每一批调用出没。
 *
 * 往回找到人开口的那条为止。中途插进来的送达不算开口，越过去接着找。
 */
export function leadsTheTurn(messages: Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant" || last.stopReason !== "pending") return false;
	const block = last.content[last.content.length - 1];
	if (block?.type !== "text" || !block.text.trim()) return false;
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (message.role === "user" && !message.delivery) return true;
		if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) return false;
	}
	return true;
}
