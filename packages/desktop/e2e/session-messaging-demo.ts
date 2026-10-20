/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 会话之间的消息，在真窗口里从头走一遍：B 正忙着自己的事时 A 问它（ask_session），A 的请求排在 B
 * 手上那件之后，A 等到的是 B 处理它那封信的那一次、不是 B 自己那件事的结论；A 在等的时候人开口，A
 * 当场回应，之后用 wait_for_session 接回那次没等完的回答；权限更窄的 D 请 B 代劳被拦下；A 请 D 做事
 * 而 D 卡在审批上，A 的等待当场返回；目录不重叠的、没在跑的都看不见；A 和 F 同时问忙着的 B，B 各开
 * 一轮、两边各拿各的回答；A 告诉忙着的 B 一件事（notify_session），当场返回，B 在这一轮里读到；A 告诉
 * 闲着的 B 一件事，B 不为它开一轮，等人在 B 那边开口时才读到。
 *
 * 模型是本地一个假的 Anthropic 端点，按对话内容决定调哪个工具、说哪句话；要验的是消息真的经过主进程
 * 路由、真的进了对方的对话、对方真的开了一轮，而等的那一方真的等到了它做完。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/session-messaging-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, press, shot, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume跨会话消息测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
process.env.PLUME_E2E_ARTIFACTS = out;
const PORT = 9813;

const A = "a1a1a1a1-0000-4000-8000-000000000001";
const B = "b2b2b2b2-0000-4000-8000-000000000002";
const C = "c3c3c3c3-0000-4000-8000-000000000003";
const D = "d4d4d4d4-0000-4000-8000-000000000004";
const E = "e5e5e5e5-0000-4000-8000-000000000005";
const F = "f6f6f6f6-0000-4000-8000-000000000006";

/** B 自己那件事、读到交接后、跑慢任务各要多久：够 A 真的等上一阵，也够人在 A 等着的时候开口。 */
const B_OWN_MS = 4000;
const B_HANDOFF_MS = 2000;
const B_SLOW_MS = 8000;
/** B 手上一件长的事：够 A、F 两边先后把信发到、各自等上，也够 A 的通知插进去。 */
const B_LONG_MS = 9000;

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

type Block = { type: string; text?: string; name?: string; content?: unknown; input?: unknown };
type Wire = { role: string; content: string | Block[] };
type Reply = ({ text: string } | { tool: { name: string; input: Record<string, unknown> } }) & { delay?: number; sent?: () => void };

/** 模型看到过的东西，供断言用。 */
const seen = {
	list: "", wait: "", letter: "", refused: "", blocked: "", spoke: "", turnsInA: 0, slowWaiting: false, slowDone: false,
	/** B 每一轮读到的是谁的信：两家并进一轮会记成 both。 */
	duoTurns: [] as string[], duoA: "", duoF: "", duoWaiting: 0, note: "", noteAt: 0, longDoneAt: 0, resume: "",
	/** 闲着时收到的通知：B 读到它的那几次请求，读到时这一轮是不是人开的。 */
	idleNote: "", idleNoteRead: 0, idleNoteWithPerson: false,
};

const blocksOf = (message: Wire): Block[] => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
const textOf = (message: Wire) => blocksOf(message).map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? JSON.stringify(block.content) : "")).join("\n");

function decide(messages: Wire[]): Reply {
	const last = messages.at(-1)!;
	const text = textOf(last);
	const result = blocksOf(last).find((block) => block.type === "tool_result");
	// 人在 A 等着的时候开口：等待交回、人的话跟在后面另成一条，这一次请求两样都看得到。
	if (text.includes("先别等了")) {
		seen.spoke = messages.slice(-2).map(textOf).join("\n");
		return { text: "好，先不等了。测试 B 还在跑慢的集成测试，跑完你再叫我看结果。" };
	}
	const asked = [...messages].reverse().map(textOf).find((one) => /PEER_[A-Z0-9]+/.test(one) && !one.includes("tool_result")) ?? "";
	const scene = asked.match(/PEER_[A-Z0-9]+/)?.[0];
	if (result) {
		const used = blocksOf(messages.at(-2)!).find((block) => block.type === "tool_use")?.name;
		const body = JSON.stringify(result.content);
		if (used === "bash") return { text: "缓存删好了。" };
		if (used === "list_sessions") {
			const ask = (to: string, message: string, sent?: () => void): Reply => ({ tool: { name: "ask_session", input: { to, message } }, sent });
			if (scene === "PEER_HANDOFF") {
				seen.list = body;
				return ask("测试 B [b2b2b2]", "测试已通过（42 passed），请你接着发版。");
			}
			if (scene === "PEER_SLOW") return ask("测试 B [b2b2b2]", "请跑一遍慢的集成测试。", () => { seen.slowWaiting = true; });
			if (scene === "PEER_ASKB") return ask("测试 B [b2b2b2]", "请帮我删掉 .cache 目录。");
			if (scene === "PEER_ASKD") return ask("检查 D [d4d4d4]", "请删掉 .cache 目录。");
			if (scene === "PEER_DUOA" || scene === "PEER_DUOF") return ask("测试 B [b2b2b2]", scene === "PEER_DUOA" ? "版本号是多少？" : "测试过没过？", () => { seen.duoWaiting++; });
			if (scene === "PEER_NOTE") return { tool: { name: "notify_session", input: { to: "测试 B [b2b2b2]", message: "我马上改 config.ts，你先别动它。" } } };
			if (scene === "PEER_NOTEIDLE") return { tool: { name: "notify_session", input: { to: "测试 B [b2b2b2]", message: "发版窗口改到明天上午。" } } };
		}
		if (used === "notify_session") {
			if (scene === "PEER_NOTE") {
				seen.note = body;
				seen.noteAt = Date.now();
				return { text: "告诉 测试 B 了，config.ts 我来改。" };
			}
			seen.idleNote = body;
			return { text: "告诉 测试 B 了：发版窗口改到明天上午。" };
		}
		if (used === "wait_for_session") {
			seen.resume = body;
			return { text: `测试 B 的慢测试：${body.includes("全部通过") ? "全部通过" : "没拿到结果"}。` };
		}
		if (used === "ask_session") {
			if (scene === "PEER_ASKB") {
				seen.refused = body;
				return { text: body.includes("broader permissions") ? "测试 B 的权限比我宽，没有发出去，请你自己处理删缓存。" : "发出去了。" };
			}
			if (scene === "PEER_HANDOFF") {
				seen.wait = body;
				return { text: body.includes("v1.2.3 已推送") ? "测试 B 做完了：v1.2.3 已推送。" : "没等到 测试 B。" };
			}
			if (scene === "PEER_ASKD") {
				seen.blocked = body;
				return { text: body.includes("waiting for its user") ? "检查 D 在等它的人批准删除 .cache，请你去那边点一下。" : "检查 D 删完了。" };
			}
			if (scene === "PEER_DUOA") {
				seen.duoA = body;
				return { text: `A 等到了：${body.includes("v1.2.3") ? "v1.2.3" : "没拿到版本号"}` };
			}
			if (scene === "PEER_DUOF") {
				seen.duoF = body;
				return { text: `F 等到了：${body.includes("测试全部通过") ? "测试全部通过" : "没拿到测试结果"}` };
			}
			return { text: "等完了。" };
		}
		return { text: "好的。" };
	}
	if (text.includes("<session-message") && text.includes("42 passed")) {
		seen.letter = text;
		return { text: "收到 发版 A 的交接，开始发版。v1.2.3 已推送。", delay: B_HANDOFF_MS };
	}
	if (text.includes("<session-message") && text.includes("慢的集成测试")) return { text: "慢的集成测试跑完了，全部通过。", delay: B_SLOW_MS, sent: () => { seen.slowDone = true; } };
	if (text.includes("<session-message") && text.includes(".cache")) return { tool: { name: "bash", input: { command: "rm -rf .cache", description: "删掉缓存目录" } } };
	// 同一轮里两封都看得到，就是两家的信被并进了一轮：照实答一句混在一起的话，等的两边就会串。
	if (text.includes("<session-message") && (text.includes("版本号是多少") || text.includes("测试过没过"))) {
		const version = text.includes("版本号是多少");
		const tests = text.includes("测试过没过");
		seen.duoTurns.push(version && tests ? "both" : version ? "version" : "tests");
		return { text: version && tests ? "版本号是 v1.2.3；测试全部通过。" : version ? "版本号是 v1.2.3。" : "测试全部通过。", delay: 1500 };
	}
	if (text.includes("<session-message") && text.includes("config.ts")) return { text: "好，我不动 config.ts。", delay: 2500 };
	if (text.includes("<session-message") && text.includes("发版窗口")) {
		seen.idleNoteRead++;
		seen.idleNoteWithPerson = messages.some((message) => textOf(message).includes("PEER_AFTER"));
		return { text: "知道了，发版窗口按明天上午算，我接着干。" };
	}
	if (text.includes("<session-message")) return { text: "多余的一轮：又收到了一条消息。" };
	if (scene === "PEER_OWN") return { text: "B 自己的检查跑完了。", delay: B_OWN_MS };
	if (scene === "PEER_OWNLONG") return { text: "B 自己的长检查跑完了。", delay: B_LONG_MS, sent: () => { seen.longDoneAt = Date.now(); } };
	if (scene === "PEER_HANDOFF") seen.turnsInA++;
	if (scene === "PEER_RESUME") return { tool: { name: "wait_for_session", input: { to: "测试 B [b2b2b2]" } } };
	if (scene === "PEER_HANDOFF" || scene === "PEER_SLOW" || scene === "PEER_ASKB" || scene === "PEER_ASKD" || scene === "PEER_DUOA" || scene === "PEER_DUOF" || scene === "PEER_NOTE" || scene === "PEER_NOTEIDLE") return { tool: { name: "list_sessions", input: {} } };
	return { text: "好的，待命。" };
}

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body: unknown = JSON.parse(raw);
			assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
			const answer = decide(body.messages as Wire[]);
			setTimeout(() => {
				reply(res, answer);
				answer.sent?.();
			}, answer.delay ?? 0);
		});
	});
}

function reply(res: ServerResponse, answer: Reply) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	const tool = "tool" in answer ? answer.tool : null;
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "text" in answer ? answer.text : "" } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const project = join(home, "project");
	const strict = join(project, "strict");
	const elsewhere = join(home, "elsewhere");
	await mkdir(join(strict, ".plume"), { recursive: true });
	await mkdir(elsewhere, { recursive: true });
	await writeFile(join(project, "README.md"), "# release\n");
	// 检查 D 跑在要审批的模式下：项目层把它改成 ask，其他会话是 full。D 请 B 代劳会被拦下。
	await writeFile(join(strict, ".plume", "config.json"), JSON.stringify({ permissionMode: "ask" }));
	const id = (cwd: string) => createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const session = (sessionId: string, title: string, cwd: string, name: string, at: number) => {
		// 侧栏不列一句话都没有的会话，所以每个先有一问一答。
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: `${title}：先看一下目录结构。` }], timestamp: at },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "看过了，目录里只有 README.md。" }], api: "anthropic-messages" as const, provider: "qa", model: "model", usage, stopReason: "stop" as const, timestamp: at },
		];
		const meta = { id: sessionId, title, titleSetByUser: true, cwd, projectId: id(cwd), projectName: name, createdAt: at, updatedAt: at, modelId: "qa/model", messageCount: messages.length, usage, seq: 1 };
		return { meta, records: [{ type: "meta" as const, meta, ts: at }, ...messages.map((message) => ({ type: "message" as const, message, ts: at }))] };
	};
	seedSessions(home, [
		session(A, "发版 A", project, "发版", Date.now() - 4 * 60_000),
		session(B, "测试 B", project, "发版", Date.now() - 6 * 60_000),
		session(D, "检查 D", strict, "严格", Date.now() - 8 * 60_000),
		session(C, "别处 C", elsewhere, "别处", Date.now() - 10 * 60_000),
		// 这次启动后谁也没碰过它：侧栏里看得见，后台没在跑，所以谁也联系不到它。
		session(E, "文档 E", project, "发版", Date.now() - 12 * 60_000),
		session(F, "排期 F", project, "发版", Date.now() - 14 * 60_000),
	]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1240, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		autoSummarizeTitle: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [
			{ id: id(project), path: project, name: "发版", pinned: true, lastOpenedAt: 3 },
			{ id: id(strict), path: strict, name: "严格", pinned: true, lastOpenedAt: 2 },
			{ id: id(elsewhere), path: elsewhere, name: "别处", pinned: true, lastOpenedAt: 1 },
		],
	}));
}

const server = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");
	const page = app;
	const main = () => page.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
	const mainHas = (text: string) => `document.querySelector("main")?.innerText.includes(${JSON.stringify(text)})`;
	const say = async (text: string) => {
		await type(page, "main textarea", text);
		await pause(500);
		await press(page, "Enter", 13);
	};
	const snap = async (name: string) => {
		await page.evaluate(`[...document.querySelectorAll("main *")].filter((node)=>node.scrollHeight>node.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(node).overflowY)).forEach((node)=>{node.scrollTop=node.scrollHeight;})`);
		await pause(600);
		await shot(page, `${stamp}_${name}`);
	};
	// 别的会话的画面可能还挂在 DOM 里只是藏着，数的时候只数看得见的。
	const visible = (selector: string) => page.evaluate<number>(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((node)=>node.checkVisibility({visibilityProperty:true})).length`);
	const leaked = async () => /运行时送达|<session-message|不构成用户对任何操作的授权/.test(await main());
	const LONG = 1800;

	// 0. 三个会话先各说一句，让它们起来（只有在跑的会话能收发消息）。文档 E 不碰。
	for (const [sessionId, name] of [[B, "测试 B"], [D, "检查 D"], [C, "别处 C"], [F, "排期 F"]] as const) {
		await openSession(page, sessionId);
		await say(`PEER_STANDBY ${name} 先待命`);
		await until(page, mainHas("好的，待命。"), LONG);
		await pause(600);
	}

	// 1. B 先忙自己的事；A 这时把活交给 B 并等。A 的消息排在 B 手上那件之后。
	await openSession(page, B);
	await say("PEER_OWN 先跑一下自己的检查");
	await pause(300);
	await openSession(page, A);
	await pause(600);
	await snap("00_改动前_发版A");
	const started = Date.now();
	await say("PEER_HANDOFF 测试过了，把发版交给 测试 B，等它发完告诉我");
	await pause(1500);
	await snap("01_A在等测试B_B还在忙自己的事");
	await until(page, mainHas("测试 B 做完了：v1.2.3 已推送。"), LONG * 8);
	const took = Date.now() - started;
	await pause(1000);
	await snap("02_A同一轮里拿到B处理这封信的结果");
	check("list_sessions 列出目录重叠的 测试 B 与 检查 D，带着权限模式", seen.list.includes("测试 B [b2b2b2] ·") && seen.list.includes("· full ·") && seen.list.includes("检查 D [d4d4d4] · idle · ask"), seen.list.slice(0, 240));
	check("目录不重叠的 别处 C、没在跑的 文档 E 不在列表里", !seen.list.includes("别处 C") && !seen.list.includes("文档 E"), { C: seen.list.includes("c3c3c3"), E: seen.list.includes("e5e5e5") });
	check("A 等到的是 B 处理这封信的那一次，不是 B 自己那件事的结论", seen.wait.includes("v1.2.3 已推送") && !seen.wait.includes("自己的检查"), { took, wait: seen.wait.slice(0, 200) });
	check("A 只为人那一句开了一轮", seen.turnsInA === 1 && !(await main()).includes("多余的一轮"), seen.turnsInA);
	check("A 的对话里没有回执行，也没有运行时原文", (await visible("main [data-peer-row]")) === 0 && !(await leaked()), await visible("main [data-peer-row]"));

	// 2. B 那边：先做完自己那件，消息另起一次，一行「来自 发版 A」。
	await openSession(page, B);
	await until(page, `document.querySelector("[data-peer-letter]")`, LONG);
	await pause(800);
	const letterRow = await page.evaluate<string>(`document.querySelector("[data-peer-letter]")?.innerText.replace(/\\s+/g," ").trim() ?? ""`);
	check("B 里出现「来自 发版 A」一行", letterRow.includes("来自 发版 A"), letterRow);
	const order = await page.evaluate<number>(`(()=>{const own=[...document.querySelectorAll("main p")].find((node)=>node.textContent.includes("B 自己的检查跑完了"));const row=document.querySelector("[data-peer-letter]");return Math.round(row.getBoundingClientRect().top-own.getBoundingClientRect().bottom);})()`);
	check("B 先答完自己那件，A 的消息排在它后面", order > 0, `${order}px`);
	check("B 处理了 A 的消息", (await main()).includes("收到 发版 A 的交接，开始发版。v1.2.3 已推送。"), "收到 发版 A 的交接");
	check("B 读到的说明让它把结果写在这一轮里，不必回消息", seen.letter.includes("不需要再发消息回复"), seen.letter.slice(0, 80));
	await click(page, "[data-peer-letter] .ly-flow-row");
	await until(page, `document.querySelector("[data-peer-open]")?.checkVisibility()`, 300);
	await frames(page, 30);
	await snap("03_B先做完自己的事_再处理A的消息");
	await click(page, "[data-peer-open]");
	await until(page, `document.querySelector('[data-ly-row="${A}"] > button[aria-current]')`, 300);
	check("「打开这个会话」跳回了 发版 A", true, "aria-current on A");
	await pause(800);

	// 3. A 在等 B 跑慢任务时，人开口：A 当场回应，不等 B。
	await say("PEER_SLOW 让 测试 B 跑一遍慢的集成测试，等它跑完");
	while (!seen.slowWaiting) await pause(100);
	await pause(1200);
	await snap("04_A在等B跑慢任务");
	const spokeAt = Date.now();
	await say("先别等了，先告诉我现状");
	await pause(300);
	const queuedRows = await visible("[data-queue-row]");
	await until(page, mainHas("好，先不等了。"), LONG * 3);
	const answeredIn = Date.now() - spokeAt;
	await pause(800);
	await snap("05_人开口后A当场回应");
	check("A 在等的时候人说的话直接送进去，没有排在输入框上方", queuedRows === 0, queuedRows);
	check("A 当场放手回应人，没等 B 跑完慢任务", seen.spoke.includes("Your user spoke") && answeredIn < B_SLOW_MS - 2000, { answeredIn, slowMs: B_SLOW_MS });
	check("放手时告诉 A：请求还在 B 那里，之后用 wait_for_session 接着等", seen.spoke.includes("Your request stays with it") && seen.spoke.includes("wait_for_session"), seen.spoke.slice(0, 240));
	while (!seen.slowDone) await pause(200);
	await pause(2000);
	check("B 跑完之后 A 这边什么都没多出来：没有回执、没有新的一轮", (await visible("main [data-peer-row]")) === 0 && !(await main()).includes("测试 B 的慢测试"), await visible("main [data-peer-row]"));
	// 3b. 人再问起：A 接着等那封没等完的，拿回的是 B 跑慢任务那一轮的回答。
	const resumedAt = Date.now();
	await say("PEER_RESUME 测试 B 的慢测试结果呢");
	await until(page, mainHas("测试 B 的慢测试："), LONG * 2);
	const resumedIn = Date.now() - resumedAt;
	await pause(1000);
	await snap("05b_A接回没等完的那次回答");
	check("wait_for_session 接回的是那封慢测试请求的回答，B 已经做完就当场返回", seen.resume.includes("慢的集成测试跑完了，全部通过。") && resumedIn < 5000, { resumedIn, resume: seen.resume.slice(0, 200) });

	// 4. 权限：D 是 ask，B 是 full。D 请 B 代劳，不送。
	await openSession(page, D);
	await say("PEER_ASKB 让 测试 B 帮忙删掉缓存");
	await until(page, mainHas("测试 B 的权限比我宽"), LONG);
	await pause(1000);
	await snap("06_D请权限更宽的B代劳被拦下");
	check("D 发给权限更宽的 B 被退回，报错让它交回给人", seen.refused.includes("broader permissions (full)") && seen.refused.includes("ask your user"), seen.refused.slice(0, 160));

	// 5. A 请 D 删缓存；D 是 ask，删之前要它的人点头。A 的等待当场返回，不干等到超时。
	await openSession(page, A);
	const askedAt = Date.now();
	await say("PEER_ASKD 请 检查 D 删掉缓存，等它删完告诉我");
	await until(page, mainHas("检查 D 在等它的人批准"), LONG * 3);
	const blockedIn = Date.now() - askedAt;
	await pause(1000);
	await snap("07_D卡在审批上_A当场告诉人");
	check("D 卡在审批上，A 的等待当场返回并说清是什么", seen.blocked.includes("waiting for its user to answer") && seen.blocked.includes("删掉缓存目录") && blockedIn < 15_000, { blockedIn, blocked: seen.blocked.slice(0, 200) });
	await openSession(page, D);
	await until(page, `document.querySelector("[data-approval-card]")`, LONG);
	await pause(1000);
	await snap("08_D那边的审批卡片");
	check("D 那边确实有一张等人点的审批卡片", (await visible("[data-approval-card]")) >= 1, await visible("[data-approval-card]"));
	await pause(1000);

	// 6. B 忙着一件长的事；A 和 F 先后找它、各自等。B 各开一轮，两边各拿各的回答。
	await openSession(page, B);
	await say("PEER_OWNLONG 跑一遍长检查");
	await pause(300);
	await openSession(page, A);
	await say("PEER_DUOA 问 测试 B 版本号，等它答");
	await openSession(page, F);
	await say("PEER_DUOF 问 测试 B 测试过没过，等它答");
	while (seen.duoWaiting < 2) await pause(100);
	await pause(800);
	await snap("09_A和F都在等忙着的B");
	await until(page, mainHas("F 等到了"), LONG * 10);
	await pause(1000);
	await snap("10_F拿到自己的回答");
	check("B 为 A、F 各开了一轮，没有把两封信并进一轮", JSON.stringify(seen.duoTurns) === JSON.stringify(["version", "tests"]), seen.duoTurns);
	check("A 等到的没有 F 那一问的回答", seen.duoA.includes("v1.2.3") && !seen.duoA.includes("测试全部通过"), seen.duoA.slice(0, 400));
	check("问只等自己这一封：A 拿回的是一段回答，不夹着别的", !seen.duoA.includes("answer 1 of") && !seen.duoA.includes("慢的集成测试"), seen.duoA.slice(0, 400));
	check("F 等到的只有测试结果", seen.duoF.includes("测试全部通过") && !seen.duoF.includes("v1.2.3"), seen.duoF.slice(0, 200));
	await openSession(page, B);
	await pause(800);
	await snap("11_B里两封信各占一轮");
	const letterRows = await visible("main [data-peer-letter]");
	await openSession(page, A);
	await pause(1000);
	await snap("12_A拿到自己的回答");
	check("A 的对话里是自己的回答", (await main()).includes("A 等到了：v1.2.3"), "A 等到了：v1.2.3");

	// 7. B 又忙着长的事；A 告诉它一件事：当场返回，B 在这一轮里读到。
	seen.longDoneAt = 0;
	await openSession(page, B);
	await say("PEER_OWNLONG 再跑一遍长检查");
	await pause(300);
	await openSession(page, A);
	await say("PEER_NOTE 告诉 测试 B 我要改 config.ts");
	await until(page, mainHas("告诉 测试 B 了，config.ts 我来改。"), LONG * 3);
	await pause(1000);
	await snap("13_A的通知当场返回");
	check("通知当场返回，说清没有回答", seen.note.includes("It reads it between its steps") && seen.note.includes("There is no answer to a notice"), seen.note.slice(0, 200));
	while (!seen.longDoneAt) await pause(200);
	check("A 拿回控制时 B 手上那件长的事还没完", seen.noteAt > 0 && seen.noteAt < seen.longDoneAt, { noteBeforeLongMs: seen.longDoneAt - seen.noteAt });
	await openSession(page, B);
	await until(page, mainHas("好，我不动 config.ts。"), LONG * 4);
	await pause(1000);
	await snap("14_B在这一轮里读到通知并调整");

	// 8. B 闲着；A 告诉它一件事：B 不为它开一轮，人在 B 那边开口时这一轮最先读到。
	await openSession(page, A);
	await say("PEER_NOTEIDLE 告诉 测试 B 发版窗口改到明天上午");
	await until(page, mainHas("告诉 测试 B 了：发版窗口改到明天上午。"), LONG * 3);
	await pause(3000);
	check("B 闲着时收到通知：没有为它开一轮", seen.idleNote.includes("It is idle and reads it when it next starts working") && seen.idleNoteRead === 0, { read: seen.idleNoteRead, note: seen.idleNote.slice(0, 160) });
	await openSession(page, B);
	await pause(800);
	await snap("15_B闲着_通知没有开一轮");
	const lettersBefore = await visible("main [data-peer-letter]");
	await say("PEER_AFTER 接着干");
	await until(page, mainHas("知道了，发版窗口按明天上午算"), LONG * 2);
	await pause(1000);
	await snap("16_人开口那一轮最先读到通知");
	check("人在 B 那边开口的那一轮读到了通知，只读一次", seen.idleNoteRead === 1 && seen.idleNoteWithPerson, { read: seen.idleNoteRead, withPerson: seen.idleNoteWithPerson });
	check("通知在 B 的对话里显示成一行", (await visible("main [data-peer-letter]")) === lettersBefore + 1, { before: lettersBefore, after: await visible("main [data-peer-letter]") });
	check("B 里先后有 发版 A、排期 F 的信", letterRows >= 3, letterRows);
	await pause(1000);
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
const video = join(out, `${stamp}_会话之间的消息_${passed}of${checks.length}.mp4`);
await encode(recorded, video);
console.log(`\n${passed}/${checks.length} 通过\n${video}`);
if (passed !== checks.length) process.exitCode = 1;
