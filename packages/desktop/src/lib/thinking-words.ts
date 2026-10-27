/**
 * What to call the waiting, and what to draw while it lasts.
 *
 * A turn is mostly silence — a loader and a number counting up. The number says how long, the
 * loader says it is alive, and neither says what kind of waiting this is. Reading a file, running
 * a test and hunting through a codebase feel different to sit through, and naming the difference
 * is most of what makes a long turn bearable.
 *
 * Written here, not asked of the model. Making it produce a status line would cost a request per
 * phrase, arrive too late to describe what it is doing now, and put one more thing in the way of
 * the actual answer. These are picked from what the agent has just done, which the window already
 * knows.
 *
 * The tone is deliberately colloquial, and in English — it sits beside `42s · 63.6k tokens`, and
 * a Chinese phrase in that row read as a different voice interrupting a technical readout. This
 * is the app muttering to itself in the corner of the screen, not a progress dialog reporting to
 * a manager.
 *
 * One classification, two consumers. The words below and the orb beside them are the same answer
 * drawn twice, so `Mood` *is* `OrbState` rather than a parallel vocabulary that has to be kept in
 * step by hand — a mood the orb cannot draw stops compiling, and an orb state nothing ever picks
 * is a missing key in `WORDS`.
 */

import type { OrbState } from "thinking-orbs";

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
export type Mood = OrbState;

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
