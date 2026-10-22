/**
 * 有过程的一轮，和里面那一段段活。
 *
 * 第一条盯的是一轮怎么摊开：没有整轮的锚和折叠，行按顺序排、不重挂。后几条盯的是一段活怎么说话，以及
 * 收着的一段活里面的调用真的不在 DOM 里——一轮四百次调用，只要它们还挂着，代价就一个不少。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { AssistantContent, Message, SessionMeta, Settings } from "@plume/core";
import { LiveToolCard, ToolRun } from "../../src/features/conversation/runs.tsx";
import { TurnWork } from "../../src/features/conversation/TurnWork.tsx";
import { WorkStep } from "../../src/features/conversation/WorkStep.tsx";
import type { Call, Run } from "../../src/features/conversation/grouping.ts";
import type { Step } from "../../src/features/conversation/turn-blocks.ts";
import { useApp } from "../../src/store/index.ts";
import { HOLD_MS } from "../../src/ui/motion/held.ts";
import { click, mount } from "../helpers/mount.ts";

const inside = h("div", { "data-probe": "inside" }, "四百条过程");
const answer = h("div", { "data-probe": "answer" }, "做好了。");
const ENTRIES = [
	{ key: "process", node: inside },
	{ key: "answer", node: answer },
];

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
const read = (id: string, path: string): ToolCall => ({ type: "toolCall", id, name: "read", arguments: { path } });
const browse = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ block: { type: "toolCall", id, name, arguments: args }, stopReason: "toolUse" });

/** 把调用的记录放进 store，就像它们真的跑过。 */
function withRuns(calls: Call[], status: "running" | "done" = "done") {
	const previous = useApp.getState();
	useApp.setState({
		activeSessionId: "s",
		capabilities: null,
		settings: { appearance: {} } as Settings,
		toolRuns: Object.fromEntries(calls.map(({ block }) => [block.id, { toolCallId: block.id, toolName: block.name, summary: block.name, args: block.arguments, status, startedAt: Date.now() - 1000 }])),
	});
	return () => useApp.setState(previous, true);
}

/** 改几条调用记录的状态，就像它们开跑或跑完。 */
const status = (next: Record<string, "running" | "done">) =>
	act(async () => {
		const runs = useApp.getState().toolRuns;
		useApp.setState({ toolRuns: { ...runs, ...Object.fromEntries(Object.entries(next).map(([id, value]) => [id, { ...runs[id], status: value }])) } });
	});

/** 等过一段停留时长，连同到点时那一次换。 */
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms + 50)));

/** 和 `Conversation` 递进去的是同一个。 */
const drawCall = ({ block, stopReason }: Call) => h(LiveToolCard, { block, stopReason });

/** 一段推理；`writing` 的还在写。 */
const thought = (writing: boolean) =>
	({
		kind: "message",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "页面出来了", startedAt: Date.now() }], stopReason: writing ? "pending" : "toolUse", timestamp: 1 } as Message,
		index: 3,
		upTo: 1,
	}) as Extract<Run, { kind: "message" }>;

const step = (calls: Call[], extra: Step["members"] = []): Step => ({
	key: `step-${calls[0].block.id}`,
	category: "browser",
	calls,
	members: [...calls.map((call) => ({ kind: "call" as const, call })), ...extra],
});

test("a turn with work draws every line in order, with no anchor and nothing folded", async () => {
	const view = await mount(h(TurnWork, { entries: ENTRIES }));
	try {
		assert.equal(view.all(".ly-turn-anchor, button[aria-expanded]").length, 0, "没有整轮的锚，也没有整轮折叠");
		assert.equal(view.all('[data-probe="inside"]').length, 1, "过程摊在对话里");
		assert.equal(view.all('[data-probe="answer"]').length, 1, "回答跟在最后");
		const said = view.find('[data-probe="answer"]');
		await view.rerender(h(TurnWork, { entries: [{ key: "later", node: h("div", null, "后来又做的") }, ...ENTRIES] }));
		assert.equal(view.find('[data-probe="answer"]'), said, "前面多出一行，原来那几行不重挂");
	} finally {
		await view.unmount();
	}
});

test("several calls of one kind are one line saying what they did, with the calls inside", async () => {
	const calls = [browse("b1", "browser_open", { url: "http://localhost:5173/todo.html" }), browse("b2", "browser_act"), browse("b3", "browser_act"), browse("b4", "browser_screenshot")];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: step(calls), live: false, draw: () => null }));
	try {
		const row = view.find<HTMLButtonElement>("button[aria-expanded]");
		assert.match(row.textContent ?? "", /^打开网页 todo\.html、操作网页 2 次、截取网页/, "做完说总的，用人话，前面不再挂「浏览器 ·」");
		assert.equal(view.all("[data-ly-tool]").length, 0, "收着的时候里面的调用不在 DOM 里");

		await click(row);
		assert.equal(view.all("[data-ly-step-rail] [data-ly-tool]").length, 4, "点开是挂在竖线上的每一次调用");
	} finally {
		await view.unmount();
		restore();
	}
});

test("while it runs the line says the call that is running, holds each for a moment, then rolls to the total", async () => {
	const calls = [browse("b1", "browser_open", { url: "todo.html" }), browse("b2", "browser_screenshot")];
	const more = [...calls, browse("b3", "browser_act")];
	const restore = withRuns(more);
	await status({ b1: "running" });
	const view = await mount(h(WorkStep, { step: step(calls), live: true, draw: () => null }));
	try {
		const words = view.find(".ly-roll-words");
		assert.equal(words.textContent, "打开网页 todo.html", "说的是还在跑的那一次，不是最后发出的那次");
		assert.ok(words.querySelector(".ly-glide"), "正在跑的那一行在扫光，光挂在字上");

		const said = words.firstElementChild;
		await status({ b1: "done", b3: "running" });
		await view.rerender(h(WorkStep, { step: step(more), live: true, draw: () => null }));
		assert.equal(words.textContent, "打开网页 todo.html", "上一句还没挂满，先不换");
		await wait(HOLD_MS);
		assert.equal(view.find(".ly-roll-words"), words, "还是同一个框，宽度从旧的缓过去");
		assert.equal(words.textContent, "操作网页", "挂满了，换成正在跑的那一次");
		assert.notEqual(words.firstElementChild, said, "换了一句话：新的一层滚进来");
		assert.ok(words.firstElementChild?.classList.contains("ly-roll-soft"));

		await status({ b3: "done" });
		await view.rerender(h(WorkStep, { step: step(more), live: false, draw: () => null }));
		assert.equal(words.textContent, "操作网页", "换成总的也要等这一句挂满");
		await wait(HOLD_MS);
		assert.equal(words.textContent, "打开网页 todo.html、截取网页、操作网页", "不再长了，滚成总的");
		assert.ok(words.firstElementChild?.classList.contains("ly-roll-soft"), "换成总的也是滚过去，不是硬换");
		assert.equal(words.querySelector(".ly-glide"), null, "停下的那一行不再扫光");
	} finally {
		await view.unmount();
		restore();
	}
});

test("thinking before the calls is counted at the front of the line", async () => {
	const calls = [browse("b1", "browser_open", { url: "todo.html" }), browse("b2", "browser_screenshot")];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: { ...step(calls), members: [{ kind: "thinking", run: thought(false) }, ...step(calls).members] }, live: false, draw: () => null }));
	try {
		assert.equal(view.find(".ly-roll-words").textContent, "思考 1 次 · 打开网页 todo.html、截取网页");
	} finally {
		await view.unmount();
		restore();
	}
});

test("thinking still being written at the end of a stretch is said at the end of that line", async () => {
	// 另一个 id：同一会话里点开过的行会被记住，前面那条点开过 `step-b1`。
	const calls = [browse("t1", "browser_open", { url: "todo.html" })];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: step(calls, [{ kind: "thinking", run: thought(true) }]), live: true, draw: () => h("div", { "data-probe": "thought" }) }));
	try {
		assert.equal(view.all(".ly-flow-row").length, 1, "推理不另起一行");
		assert.equal(view.find(".ly-roll-words").textContent, "打开网页 todo.html", "跑着时说的还是那一次调用，推理的次数等停下再算进去");
		assert.match(view.text(), /正在思考/, "还在写的那段在句尾说一声");
	} finally {
		await view.unmount();
		restore();
	}
});

test("a read says its path from the workspace, a search says the model's words", async () => {
	const tool = (id: string, name: string, args: Record<string, unknown>): Call => ({ block: { type: "toolCall", id, name, arguments: args }, stopReason: "toolUse" });
	const calls = [
		// 历史里还带着说明的读文件：路径比模型的转述准，说明不再上行。
		tool("d1", "read", { path: "/repo/apps/web/src/main.tsx", description: "读取第三上游响应归一化" }),
		tool("d2", "read", { path: "apps/cli/src/main.ts", offset: 10, limit: 20 }),
		// 模型把没给的参数写成 null：不当行号。
		tool("d3", "read", { path: "README.md", offset: null, limit: null }),
		tool("d4", "ls", { path: "/repo/apps/api/src" }),
		tool("d5", "ls", {}),
		tool("d6", "grep", { pattern: "timeout|overtime", description: "找超时相关的处理" }),
	];
	const restore = withRuns(calls);
	useApp.setState({ meta: { cwd: "/repo" } as SessionMeta });
	// 一个一个挂：`act` 叠在一起时，后面几条测试拿到的是没提交完的树。
	const rows = [];
	for (const call of calls) rows.push(await mount(drawCall(call)));
	try {
		const said = rows.map((row) => row.text());
		assert.match(said[0], /^读取文件 apps\/web\/src\/main\.tsx/, "相对工作区的完整路径，两个 main 分得开");
		assert.match(said[1], /^读取文件 apps\/cli\/src\/main\.ts:10-29/, "只读一段的带行号");
		assert.match(said[2], /^读取文件 README\.md(?!:)/);
		assert.match(said[3], /^列出目录 apps\/api\/src\//, "目录带 /");
		assert.match(said[4], /^列出目录 \.\//);
		assert.match(said[5], /^找超时相关的处理/, "正则人读不出来，说明留着");
	} finally {
		for (const row of rows) await row.unmount();
		restore();
	}
});

test("checking one background job three times in a row is one line that names the job", async () => {
	const tool = (id: string, name: string, args: Record<string, unknown>): Call => ({ block: { type: "toolCall", id, name, arguments: args }, stopReason: "toolUse" });
	const calls = [
		tool("j0", "bash", { command: "pnpm test:e2e", description: "跑端到端测试", run_in_background: true }),
		tool("j1", "bash_output", { id: "job-1" }),
		tool("j2", "bash_output", { id: "job-1" }),
		tool("j3", "bash_output", { id: "job-1" }),
		tool("j4", "bash", { command: "git status", description: "看看改了哪些文件" }),
	];
	const previous = useApp.getState();
	const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
	const results: Record<string, { summary: string; result: { content: { type: "text"; text: string }[]; details?: unknown } }> = {
		j0: { summary: "跑端到端测试", result: { ...text("Started background job job-1."), details: { kind: "bash_background", id: "job-1", command: "pnpm test:e2e" } } },
		j1: { summary: "Check job", result: text("[job job-1 running]\n第 1 批通过\n") },
		j2: { summary: "Check job", result: text("[job job-1 running]\n(no new output)") },
		j3: { summary: "Check job", result: text("[job job-1 exited with code 0]\n第 2 批通过\n") },
		j4: { summary: "看看改了哪些文件", result: text("clean") },
	};
	useApp.setState({
		activeSessionId: "s",
		capabilities: null,
		settings: { appearance: {} } as Settings,
		toolRuns: Object.fromEntries(calls.map(({ block }) => [block.id, { toolCallId: block.id, toolName: block.name, args: block.arguments, status: "done" as const, startedAt: Date.now() - 1000, ...results[block.id] }])),
	});
	const view = await mount(h(WorkStep, { step: { ...step(calls), category: "terminal" }, live: false, draw: () => null }));
	try {
		const head = view.find(".ly-flow-row").textContent ?? "";
		assert.match(head, /^执行命令 2 个/, "查输出是那条命令的一部分，不另记");
		assert.doesNotMatch(head, /查看输出/);
		await click(view.find(".ly-flow-row"));
		const lines = view.all("[data-ly-step-rail] [data-ly-tool] > .ly-flow-row").map((row) => row.textContent ?? "");
		assert.deepEqual(lines.map((line) => line.replace(/\s+/g, " ").trim()), ["跑端到端测试", "查看「跑端到端测试」的输出 3 次", "看看改了哪些文件"]);
		// 点开合起来的那一行：摆的是那条命令，三次的输出接在一起，任务 id 和占位都不出现。
		const polls = view.all<HTMLElement>("[data-ly-step-rail] [data-ly-tool]")[1];
		await click(polls.querySelector(".ly-flow-row")!);
		const body = polls.textContent ?? "";
		assert.match(body, /pnpm test:e2e/);
		assert.match(body, /第 1 批通过\s*第 2 批通过/);
		assert.doesNotMatch(body, /job-1|no new output/);
	} finally {
		await view.unmount();
		useApp.setState(previous, true);
	}
});

test("one call is the call's own row", async () => {
	const calls = [browse("b1", "browser_open", { url: "https://example.com/" })];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: step(calls), live: false, draw: () => null }));
	try {
		assert.equal(view.all("[data-ly-tool]").length, 1);
		assert.match(view.text(), /打开网页 example\.com/, "没写 summarize 的工具不再露出 browser_open 这种名字");
	} finally {
		await view.unmount();
		restore();
	}
});

test("a background command that came back failed marks its stretch, and hangs on the rail where it came back", async () => {
	const calls = [browse("g1", "bash", { command: "pnpm test", description: "跑测试", run_in_background: true })];
	const back = {
		kind: "message",
		message: { role: "user", content: [{ type: "text", text: "<report>" }], synthetic: true, steered: true, delivery: [{ id: "j1", kind: "job", agent: "", description: "跑测试", status: "failed", exitCode: 1 }], timestamp: 1 } as Message,
		index: 2,
		upTo: 1,
	} as Extract<Run, { kind: "message" }>;
	const restore = withRuns(calls);
	const draw = (run: Run) => (run === back ? h("div", { "data-probe": "job" }, "后台命令失败") : null);
	const view = await mount(h(WorkStep, { step: step(calls, [{ kind: "job", run: back }]), live: false, draw }));
	try {
		const row = view.find<HTMLButtonElement>("button[aria-expanded]");
		assert.ok(row.querySelector(".text-danger\\/85"), "启动它的那次 bash 是跑完了的，失败只在回来的结果上");
		assert.equal(view.all('[data-probe="job"]').length, 0, "一次调用也要竖线来挂它，不画成那次调用自己的一行");
		await click(row);
		assert.equal(view.all('[data-ly-step-rail] [data-probe="job"]').length, 1, "点开时排在它回来的位置");
	} finally {
		await view.unmount();
		restore();
	}
});

test("panels without an anchor still draw each call as a row of its own when asked to", async () => {
	const previous = useApp.getState();
	const calls = [read("r1", "src/a.ts"), read("r2", "src/b.ts")];
	useApp.setState({
		activeSessionId: "flat",
		capabilities: null,
		settings: { appearance: {} } as Settings,
		toolRuns: Object.fromEntries(calls.map((call) => [call.id, { toolCallId: call.id, toolName: "read", summary: `Read ${String(call.arguments.path)}`, args: call.arguments, status: "done" as const, startedAt: Date.now() - 1000 }])),
	});
	const view = await mount(h(ToolRun, { calls: calls.map((block) => ({ block, stopReason: "toolUse" as const })), flat: true }));
	try {
		assert.equal(view.all("[data-ly-run] > button").length, 0, "no group line over them");
		const rows = view.all<HTMLElement>("[data-ly-tool]");
		assert.equal(rows.length, 2, "one row per call");
		assert.match(rows[0].textContent ?? "", /读取文件 src\/a\.ts/, "core's English summary is not what the row says");
	} finally {
		await view.unmount();
		useApp.setState(previous, true);
	}
});

/*
 * 元数据每写一条记录就换一个新对象，一次并行工具就是十几次；分组每次转录变了都重做，每一段都是新对象。
 * 两样都不该让一段没变的活重画——会话一长，可见的每一段都跟着重画，CPU 就随会话长度往上涨。
 */
test("a step that has not changed is not redrawn when the meta or the grouping is renewed", async () => {
	const calls = [browse("r1", "read", { path: "a.ts" }), browse("r2", "read", { path: "b.ts" })];
	const restore = withRuns(calls);
	const meta = { id: "s", cwd: "/project", seq: 1 } as unknown as SessionMeta;
	useApp.setState({ meta });
	// 段里挂一段推理：这一段每画一次，就要调一次 `draw` 画它。
	const thinking = thought(false);
	let drawn = 0;
	const draw = () => { drawn++; return null; };
	// 外部状态一变，`Conversation` 交来的就是另一个 `draw`。
	const redraw = () => { drawn++; return null; };
	const at = (live: boolean, drawer = draw) => h(WorkStep, { step: step(calls, [{ kind: "thinking", run: thinking }]), live, draw: drawer });
	const view = await mount(at(false));
	try {
		drawn = 0;
		await act(async () => useApp.setState({ meta: { ...meta, seq: 2 } as SessionMeta }));
		assert.equal(drawn, 0, "元数据只换了 seq，这一段不重画");
		await view.rerender(at(false));
		assert.equal(drawn, 0, "分组重做出来的同一段，不重画");
		await view.rerender(at(false, redraw));
		assert.equal(drawn, 1, "画推理那一行要的外部状态变了，要重画");
		await view.rerender(at(true, redraw));
		assert.equal(drawn, 2, "成了正在做的那一段，要重画");
		await act(async () => useApp.setState({ meta: { ...meta, cwd: "/elsewhere", seq: 3 } as SessionMeta }));
		assert.equal(drawn, 3, "读的那一样（cwd）变了，照样重画");
	} finally {
		await view.unmount();
		restore();
	}
});
