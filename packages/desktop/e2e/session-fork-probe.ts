/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 「从这里分叉」 in the real window with the real pointer, on a question and on a reply.
 *
 * A three-question conversation whose third answer went through a tool call. Measured from what is on
 * screen and on disk:
 *
 * - which messages offer it: every question, every reply that ended — not the sentence that handed over
 *   to the tool;
 * - forking the second question: the new conversation in the sidebar, hung under the original, holds
 *   what came before it, with the question in its composer; it is sent, and the original keeps every message;
 * - forking the second answer: the new conversation holds it and nothing after, with an empty composer;
 *   a new question is sent from there, and the original keeps every message;
 * - the trajectory inspector's menu no longer offers a fork.
 *
 * `--before` only takes the two pictures that change — a reply's row, the inspector's menu — from the
 * renderer last built into `out/`. The default run loads the renderer from a dev server of its own, so
 * it measures the source as it is, beside a `pnpm dev` that may hold `out/` and port 5173.
 *
 *   pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/session-fork-probe.ts [--before]
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, focus, hover, openPane, openSession, press, shot, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT = join(homedir(), "Desktop", "Plume消息分叉测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const phase = process.argv.includes("--before") ? "before" : "after";
process.env.PLUME_E2E_ARTIFACTS = OUT;
const PORT = 9437;

const Q1 = "帮我起草一份 0.9 版发布说明的提纲";
const A1 = "提纲：一、这一版解决了什么；二、改动明细；三、升级须知。";
const Q2 = "把第二节展开写成三段";
const A2 = "第二节展开如下：先说输入框，再说分屏，最后说同步。";
const Q3 = "对照 notes.md 补上遗漏的改动";
const H3 = "先读一下 notes.md。";
const A3 = "补了两条：设置页的搜索、导出轨迹。";
const FORKED_REPLY = "（分叉里的回答）第二节换个写法：按用户会碰到的场景来组织。";
const AFTER_REPLY = "换个方向：第二节改成按版本号倒序列";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${name}\n     ${detail}`);
}

let app: RunningApp | undefined;
let server: Server | undefined;
let renderer: Awaited<ReturnType<typeof startDevRenderer>> | undefined;
const frames: Frame[] = [];
let stopRecording: (() => Promise<void>) | undefined;

async function picture(name: string) {
	await pause(500);
	await shot(app!, `${stamp}_${phase}_${name}`);
	console.log(`   📸 ${join(OUT, `${stamp}_${phase}_${name}.png`)}`);
}

const mainText = () => app!.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
const stored = (id: string) => app!.evaluate<number>(`window.plume.sessions.transcript(${JSON.stringify(id)}).then((t) => (t.messages ?? t).length)`);
const rows = () => app!.evaluate<{ id: string; title: string; nested: boolean; current: boolean }[]>(`[...document.querySelectorAll('[data-ly-row]')].map((row) => ({ id: row.getAttribute('data-ly-row'), title: row.innerText.trim().split(String.fromCharCode(10))[0], nested: row.hasAttribute('data-ly-row-nested'), current: Boolean(row.querySelector(':scope > button[aria-current]')) }))`);

/** The reply holding `text`, marked so the pointer can be sent to it: replies carry no index of their own. */
async function markReply(text: string, key: string) {
	await until(app!, `[...document.querySelectorAll('main [data-ly-quote="assistant"]')].some((e) => e.innerText.includes(${JSON.stringify(text)}))`);
	await app!.evaluate(`[...document.querySelectorAll('main [data-ly-quote="assistant"]')].find((e) => e.innerText.includes(${JSON.stringify(text)})).setAttribute('data-probe-reply', ${JSON.stringify(key)})`);
	return `[data-probe-reply="${key}"]`;
}

/** The trajectory pane, a record picked, its 「记录操作」 menu open; what the menu offers. */
async function traceMenu(): Promise<string[]> {
	await openPane(app!, "轨迹");
	await until(app!, `document.querySelector('[data-dock-pane="trajectory"] [data-trace-entry]')`);
	await click(app!, '[data-dock-pane="trajectory"] [data-trace-entry]');
	await until(app!, `document.querySelector('.ly-trace-inspector')`);
	await click(app!, '[data-trace-inspector-header] button[aria-label="记录操作"]');
	await until(app!, `document.querySelector('[role="menuitem"]')`);
	await pause(400);
	return app!.evaluate<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
}

try {
	await mkdir(OUT, { recursive: true });
	server = createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
			emit("message_start", { message: { id: "fork-reply", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: FORKED_REPLY } });
			emit("content_block_stop", { index: 0 });
			emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
			emit("message_stop", {});
			res.end();
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fixture port");

	if (phase === "after") renderer = await startDevRenderer();
	app = await startApp({
		port: PORT,
		...(renderer ? { rendererUrl: renderer.url } : {}),
		seed: async (home) => {
			const cwd = join(home, "project");
			await mkdir(cwd, { recursive: true });
			const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1400, height: 880, x: 40, y: 40 }));
			await writeFile(join(home, "settings.json"), JSON.stringify({
				uiLocale: "zh-CN", permissionMode: "full", projectMemory: false, thinking: "off", autoSummarizeTitle: false,
				mcpServers: [], hooks: [], sync: { enabled: false }, appearance: { theme: "light", reduceMotion: "on" },
				projects: [{ path: cwd, name: "发布", pinned: true, lastOpenedAt: Date.now() }],
				defaultModelId: "fake/model",
				providers: [{ id: "fake", name: "假模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "probe", enabled: true,
					models: [{ id: "fake/model", providerId: "fake", modelId: "model", name: "假模型", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }] }],
			}));
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			const now = Date.now();
			const meta = { id: "release-notes", title: "发布说明", projectId, projectName: "发布", cwd, createdAt: now - 90_000, updatedAt: now, modelId: "fake/model", messageCount: 8, usage, seq: 9 };
			const say = (text: string, at: number) => ({ role: "user", content: [{ type: "text", text }], timestamp: at });
			const reply = (content: object[], at: number, stopReason = "stop") => ({ role: "assistant", content, api: "anthropic-messages", provider: "fake", model: "model", usage, stopReason, timestamp: at });
			const text = (value: string) => ({ type: "text", text: value });
			const at = (ago: number) => ({ ts: now - ago });
			seedSessions(home, [{ meta, records: [
				{ ...at(90_000), type: "meta", meta: { ...meta, seq: 1 } },
				{ ...at(80_000), type: "message", message: say(Q1, now - 80_000) },
				{ ...at(75_000), type: "message", message: reply([text(A1)], now - 75_000) },
				{ ...at(60_000), type: "message", message: say(Q2, now - 60_000) },
				{ ...at(55_000), type: "message", message: reply([text(A2)], now - 55_000) },
				{ ...at(40_000), type: "message", message: say(Q3, now - 40_000) },
				{ ...at(35_000), type: "message", message: reply([text(H3), { type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } }], now - 35_000, "toolUse") },
				{ ...at(34_000), type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [text("设置页搜索；导出轨迹")], isError: false, timestamp: now - 34_000 } },
				{ ...at(30_000), type: "message", message: reply([text(A3)], now - 30_000) },
			] }]);
		},
	});
	await app.evaluate("document.fonts.ready");
	if (phase === "after") stopRecording = await startRecording(PORT, frames);

	await openSession(app, "release-notes");
	await until(app, `document.querySelector('main')?.innerText.includes(${JSON.stringify(A3)})`);
	await pause(900);

	if (phase === "before") {
		await hover(app, await markReply(A2, "a2"));
		await pause(600);
		await picture("00_悬停第二个回答");
		console.log(`   轨迹菜单：${JSON.stringify(await traceMenu())}`);
		await picture("01_轨迹记录操作菜单");
	} else {
		console.log("① 哪些消息上有「从这里分叉」");
		const offered = await app.evaluate<{ total: number; handover: number; replies: number }>(`(() => {
			const replies = [...document.querySelectorAll('main [data-ly-quote="assistant"]')];
			const handover = replies.find((e) => e.innerText.includes(${JSON.stringify(H3)}));
			return {
				total: document.querySelectorAll('main [data-message-fork]').length,
				handover: handover ? handover.querySelectorAll('[data-message-fork]').length : -1,
				replies: replies.filter((e) => e.querySelector('[data-message-fork]')).length,
			};
		})()`);
		check("三个问题、三条说完的回答各一个，交给工具的那一句没有", offered.total === 6 && offered.replies === 3 && offered.handover === 0, JSON.stringify(offered));

		await hover(app, await markReply(A2, "a2"));
		await pause(600);
		const tip = await app.evaluate<string | null>(`document.querySelector('[data-probe-reply="a2"] [data-message-fork]')?.getAttribute('data-ly-tip') ?? null`);
		check("第二个回答的操作排里有「从这里分叉」", tip === "从这里分叉", JSON.stringify(tip));
		await picture("00_悬停第二个回答");
		await hover(app, '[data-probe-reply="a2"] [data-message-fork]');
		await pause(900);
		await picture("01_悬停回答上的从这里分叉");

		console.log("② 在第二个问题上分叉：新会话停在它之前，问题回到输入框");
		await click(app, '[data-question-index="2"] [data-message-fork]');
		await until(app, `!document.querySelector('main')?.innerText.includes(${JSON.stringify(A2)})`);
		await pause(900);
		let list = await rows();
		const beforeFork = list.find((row) => row.current);
		const parentAt = list.findIndex((row) => row.id === "release-notes");
		check("问题分叉挂在原会话下面、是当前会话", Boolean(beforeFork?.title === "发布说明（分叉）" && beforeFork.nested && list.indexOf(beforeFork) > parentAt), JSON.stringify(list));
		let text = await mainText();
		check("问题分叉里只有第二个问题之前的一问一答", text.includes(Q1) && text.includes(A1) && !text.includes(A2), `含第一答：${text.includes(A1)}，含第二答：${text.includes(A2)}`);
		const draft = await app.evaluate<string>(`document.querySelector('main textarea')?.value ?? ''`);
		check("第二个问题回到了分叉的输入框里", draft === Q2, JSON.stringify(draft));
		await picture("02_问题分叉");
		await focus(app, "main textarea");
		await press(app, "Enter", 13);
		await until(app, `document.querySelector('main')?.innerText.includes(${JSON.stringify(FORKED_REPLY)})`, 1800);
		await pause(1200);
		check("问题分叉发出去有了回答，原会话还是 8 条", (await stored("release-notes")) === 8, `原会话 ${await stored("release-notes")} 条消息`);

		console.log("③ 回到原会话，在第二个回答上分叉：新会话带着这条回答，输入框是空的");
		await openSession(app, "release-notes");
		await until(app, `document.querySelector('main')?.innerText.includes(${JSON.stringify(A3)})`);
		await pause(700);
		await click(app, `${await markReply(A2, "a2")} [data-message-fork]`);
		await until(app, `[...document.querySelectorAll('[data-ly-row]')].filter((row) => row.innerText.includes('（分叉）')).length === 2`);
		await until(app, `!document.querySelector('main')?.innerText.includes(${JSON.stringify(Q3)})`);
		await pause(900);
		list = await rows();
		const afterFork = list.find((row) => row.current);
		check("回答分叉也挂在原会话下面、是当前会话", Boolean(afterFork && afterFork.id !== beforeFork?.id && afterFork.title === "发布说明（分叉）" && afterFork.nested), JSON.stringify(list));
		text = await mainText();
		check("回答分叉里到第二个回答为止，后面的问题和工具都没有", text.includes(Q2) && text.includes(A2) && !text.includes(Q3) && !text.includes(H3), `含第二答：${text.includes(A2)}，含第三问：${text.includes(Q3)}，含工具那句：${text.includes(H3)}`);
		const onDisk = afterFork ? await app.evaluate<{ count: number; last: string }>(`window.plume.sessions.transcript(${JSON.stringify(afterFork.id)}).then((t) => { const m = t.messages ?? t; return { count: m.length, last: m.at(-1)?.role }; })`) : null;
		check("回答分叉存下来的是 4 条，最后一条是那条回答", onDisk?.count === 4 && onDisk.last === "assistant", JSON.stringify(onDisk));
		const empty = await app.evaluate<string>(`document.querySelector('main textarea')?.value ?? ''`);
		check("回答分叉的输入框是空的", empty === "", JSON.stringify(empty));
		check("原会话一条都没少", (await stored("release-notes")) === 8, `原会话 ${await stored("release-notes")} 条消息`);
		await picture("03_回答分叉");
		await type(app, "main textarea", AFTER_REPLY);
		await pause(600);
		await press(app, "Enter", 13);
		await until(app, `document.querySelector('main')?.innerText.includes(${JSON.stringify(FORKED_REPLY)})`, 1800);
		await pause(1200);
		const grown = afterFork ? await stored(afterFork.id) : 0;
		check("回答分叉接着问下去有了回答（6 条），原会话还是 8 条", grown === 6 && (await stored("release-notes")) === 8, `分叉 ${grown} 条，原会话 ${await stored("release-notes")} 条`);
		await picture("04_回答分叉接着往下说");

		console.log("④ 轨迹里的记录操作不再有「从这里分叉」");
		await openSession(app, "release-notes");
		await until(app, `document.querySelector('main')?.innerText.includes(${JSON.stringify(A3)})`);
		const menu = await traceMenu();
		check("记录操作菜单里没有「从这里分叉」", menu.length > 0 && !menu.includes("从这里分叉"), JSON.stringify(menu));
		await picture("05_轨迹记录操作菜单");
		await pause(1200);
	}
} catch (error) {
	check("探针跑完", false, String(error));
} finally {
	await stopRecording?.();
	const passed = results.filter((r) => r.ok).length;
	console.log(`\n${passed}/${results.length} 通过　（${phase}）`);
	await app?.stop();
	await renderer?.close();
	if (server) await closeListeningServer(server);
	if (frames.length) {
		const video = join(OUT, `${stamp}_消息分叉_${passed}of${results.length}.mp4`);
		await encode(frames, video);
		console.log(`   🎬 ${video}`);
	}
	if (passed !== results.length) process.exitCode = 1;
}
