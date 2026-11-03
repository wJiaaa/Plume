/**
 * 每拍只重算最后一轮的那一版（`transcript-shape.ts`）和从头算的那一版，结果必须逐项相同。
 *
 * 对拍：随机生成一段会话的整个过程——流式回复、并行工具、插话、后台结果送达、「继续」、清单、页面检查
 * 与发布、换模型、压缩命令、断线——每一步都同时交给两版，再在中途随机撤回（截断）、编辑（换掉一条再截断），
 * 每一步比一次。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandRun, Message } from "@plume/core";
import { runs } from "../src/features/conversation/grouping.ts";
import { turnBlocks, withoutThinking } from "../src/features/conversation/turn-blocks.ts";
import { questionsIn, timeSeparators } from "../src/features/conversation/question-navigation.ts";
import { NavigationCache, RunsCache, TurnBlocksCache } from "../src/features/conversation/transcript-shape.ts";
import { CARRY_ON_PROMPTS } from "../src/store/derive.ts";
import type { Hiccup } from "../src/lib/hiccup.ts";

/** 可复现的随机数（mulberry32）。 */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Assistant = Extract<Message, { role: "assistant" }>;
type Block = Assistant["content"][number];

interface Session {
	messages: Message[];
	commands: CommandRun[];
	hiccups: Hiccup[];
	running: boolean;
}

/** 一段会话的整个过程，一步一个快照；每个快照都是新数组，没变的消息沿用原来的对象，和 store 一样。 */
function* timeline(seed: number, steps: number): Generator<Session> {
	const rand = random(seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
	let clock = 1_700_000_000_000 + seed * 1000;
	const now = () => (clock += Math.floor(rand() * 40 * 60_000));
	let messages: Message[] = [];
	let commands: CommandRun[] = [];
	let hiccups: Hiccup[] = [];
	let running = false;
	let call = 0;
	let model = "m1";
	/** 发出去还没有结果的调用。 */
	let open: { id: string; name: string }[] = [];
	const snap = (): Session => ({ messages, commands, hiccups, running });
	const push = (message: Message) => (messages = [...messages, message]);
	const user = (text: string, extra: Record<string, unknown> = {}): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: now(), ...extra }) as Message;
	const toolCall = (): Block => {
		const name = pick(["read", "bash", "bash", "edit", "preview", "preview", "todo_write", "web_fetch", "browser_click"]);
		const id = `call-${seed}-${call++}`;
		const args: Record<string, unknown> =
			name === "bash" ? { command: pick(["rg foo", "sed -n 1,5p a.ts", "pnpm test", "git status"]) }
			: name === "preview" ? (rand() < 0.5 ? { check: true, html: "<p/>" } : { id: `page-${Math.floor(rand() * 3)}` })
			: name === "todo_write" ? { todos: [] }
			: { path: `src/${call}.ts` };
		open.push({ id, name });
		return { type: "toolCall", id, name, arguments: args } as Block;
	};

	for (let step = 0; step < steps; step++) {
		const roll = rand();
		const last = messages[messages.length - 1];
		if (last?.role === "assistant" && last.stopReason === "pending") {
			// 流式：长一截，或者收尾。
			const content = last.content.slice();
			const tail = content[content.length - 1];
			if (rand() < 0.6 && tail && (tail.type === "text" || tail.type === "thinking")) {
				content[content.length - 1] = tail.type === "text" ? { ...tail, text: `${tail.text} 字` } : { ...tail, thinking: `${tail.thinking} 想` };
			} else if (rand() < 0.3) {
				content.push(rand() < 0.5 ? { type: "text", text: "接着说" } : toolCall());
			} else {
				const calls = content.some((block) => block.type === "toolCall");
				const stopReason = calls ? "toolUse" : pick(["stop", "stop", "stop", "aborted", "error", "length"] as const);
				messages = [...messages.slice(0, -1), { ...last, content, stopReason, durationMs: Math.floor(rand() * 5000) }];
				if (!calls) running = false;
				yield snap();
				continue;
			}
			messages = [...messages.slice(0, -1), { ...last, content }];
		} else if (open.length > 0 && roll < 0.7) {
			// 工具结果，顺序不定；偶尔先插一句话进来（插话），结果后到。
			if (rand() < 0.1) push(user("插一句：顺便看看测试"));
			const done = open.splice(Math.floor(rand() * open.length), 1)[0];
			const isError = rand() < 0.15;
			const details =
				done.name === "todo_write" ? { kind: "todo", todos: [{ content: "a", status: rand() < 0.5 ? "pending" : "completed" }] }
				: done.name === "preview" && !isError ? { kind: "preview-check", id: `page-${Math.floor(rand() * 3)}` }
				: undefined;
			push({ role: "toolResult", toolCallId: done.id, toolName: done.name, content: [{ type: "text", text: "ok" }], isError, timestamp: now(), ...(details ? { details } : {}) } as Message);
			if (open.length === 0) {
				running = true;
				push({ role: "assistant", content: [], stopReason: "pending", timestamp: now(), provider: "p", model, usage } as Assistant);
			}
		} else if (roll < 0.06 && messages.length > 2) {
			// 撤回：截到某一句人话之前。
			const users = messages.flatMap((message, index) => (message.role === "user" && !message.synthetic ? [index] : []));
			const cut = users.length ? pick(users) : messages.length - 1;
			messages = messages.slice(0, cut);
			commands = commands.filter((one) => one.at <= cut);
			hiccups = hiccups.filter((one) => one.at <= cut);
			open = [];
			running = false;
		} else if (roll < 0.1 && messages.length > 2) {
			// 编辑：换掉一句人话、截掉后面，重新开一轮。
			const users = messages.flatMap((message, index) => (message.role === "user" && !message.synthetic ? [index] : []));
			if (users.length) {
				const at = pick(users);
				messages = [...messages.slice(0, at), user("改过的问题")];
				commands = commands.filter((one) => one.at <= at);
				hiccups = hiccups.filter((one) => one.at <= at);
				open = [];
				running = true;
				push({ role: "assistant", content: [], stopReason: "pending", timestamp: now(), provider: "p", model, usage } as Assistant);
			}
		} else if (roll < 0.14) {
			commands = [...commands, { id: `cmd-${step}`, name: "compact", timestamp: now(), input: "/compact", at: messages.length, status: "running", detail: "" }];
		} else if (roll < 0.17 && commands.length) {
			// 命令状态变了：换一个对象，和 store 一样。
			const at = Math.floor(rand() * commands.length);
			commands = commands.map((one, index) => (index === at ? { ...one, status: "done" } : one));
		} else if (roll < 0.2) {
			hiccups = [...hiccups, { id: `h-${step}`, at: messages.length, attempts: 1 } as unknown as Hiccup];
		} else {
			// 开一轮：人话、继续、后台结果送达、另一个会话的来信，或者运行时自己的提示。
			if (rand() < 0.15) model = pick(["m1", "m2"]);
			const kind = rand();
			const previous = [...messages].reverse().find((message) => message.role === "assistant") as Assistant | undefined;
			if (kind < 0.12 && previous && (previous.stopReason === "aborted" || previous.stopReason === "error")) push(user(CARRY_ON_PROMPTS[0]));
			else if (kind < 0.22) push(user("后台命令结束", { synthetic: true, delivery: [{ id: `job-${step}`, kind: "job", description: "build", status: "done" }], steered: rand() < 0.5 }));
			else if (kind < 0.28) push(user("另一个会话说", { synthetic: true, peer: { sessionId: "other", title: "B" } }));
			else if (kind < 0.33) push(user("（自动提示）清单还没做完", { synthetic: true }));
			else push(user(pick(["看看这个", "修一下", "为什么", ""]), rand() < 0.05 ? { clearsTaskPlan: true } : {}));
			open = [];
			running = true;
			const first: Block[] = rand() < 0.5 ? [{ type: "thinking", thinking: "想" } as Block] : [];
			push({ role: "assistant", content: first.length ? first : [rand() < 0.5 ? { type: "text", text: "好" } : toolCall()], stopReason: "pending", timestamp: now(), provider: "p", model, usage } as Assistant);
		}
		yield snap();
	}
}

function compare(seed: number, steps: number) {
	const shape = { runs: new RunsCache(), blocks: new TurnBlocksCache(), navigation: new NavigationCache() };
	const rand = random(seed ^ 0x5eed);
	let step = 0;
	for (const session of timeline(seed, steps)) {
		step++;
		const { messages, commands, hiccups, running } = session;
		// 推理画不画中途会被人切换，同一份缓存两种都要对。
		const showThinking = rand() < 0.3;
		const where = `seed ${seed} step ${step}`;
		const full = runs(messages, commands, hiccups);
		const expectedRuns = showThinking ? full : withoutThinking(full);
		const cachedRuns = shape.runs.runs(messages, commands, hiccups, showThinking);
		assert.deepStrictEqual(cachedRuns, expectedRuns, `runs, ${where}`);
		assert.deepStrictEqual(shape.blocks.turnBlocks(cachedRuns, running), turnBlocks(expectedRuns, running), `turnBlocks, ${where}`);
		assert.deepStrictEqual(shape.navigation.timeSeparators(messages), timeSeparators(messages), `timeSeparators, ${where}`);
		assert.deepStrictEqual(shape.navigation.questionsIn(messages), questionsIn(messages), `questionsIn, ${where}`);
	}
}

test("the cached shape matches the shape computed from scratch, step by step, over random sessions", () => {
	for (let seed = 1; seed <= 160; seed++) compare(seed, 220);
});

test("while a reply streams, the turns before it keep their rows and blocks", () => {
	const shape = { runs: new RunsCache(), blocks: new TurnBlocksCache() };
	const at = (n: number) => 1_700_000_000_000 + n * 1000;
	const messages: Message[] = [];
	for (let turn = 0; turn < 30; turn++) {
		messages.push({ role: "user", content: [{ type: "text", text: `问 ${turn}` }], timestamp: at(messages.length) });
		messages.push({ role: "assistant", content: [{ type: "toolCall", id: `c${turn}`, name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse", timestamp: at(messages.length), provider: "p", model: "m", usage });
		messages.push({ role: "toolResult", toolCallId: `c${turn}`, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: at(messages.length) });
		messages.push({ role: "assistant", content: [{ type: "text", text: `答 ${turn}` }], stopReason: "stop", timestamp: at(messages.length), provider: "p", model: "m", usage });
	}
	const asked: Message = { role: "user", content: [{ type: "text", text: "再问" }], timestamp: at(500) };
	const streaming = (text: string): Message[] => [...messages, asked, { role: "assistant", content: [{ type: "text", text }], stopReason: "pending", timestamp: at(501), provider: "p", model: "m", usage }];
	const first = shape.runs.runs(streaming("一"), [], [], false);
	const firstBlocks = shape.blocks.turnBlocks(first, true);
	const second = shape.runs.runs(streaming("一二"), [], [], false);
	const secondBlocks = shape.blocks.turnBlocks(second, true);
	const settled = first.length - 2;
	assert.ok(first.slice(0, settled).every((run, index) => second[index] === run), "前面那几轮的行是同一批对象");
	assert.ok(firstBlocks.slice(0, -2).every((block, index) => secondBlocks[index] === block), "前面那几轮的块也是");
	assert.notEqual(second[second.length - 1], first[first.length - 1]);
});
