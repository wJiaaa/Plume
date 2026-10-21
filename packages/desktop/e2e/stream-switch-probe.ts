/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一条回复还在写，切去别的会话、过一会再切回来：回来那一刻正文是什么样、之后每帧长多少字。
 *
 * 离开期间写下的字是旧事，回来的第一帧就该在；之后到的字照常一点点放。量两种回来：
 * - `retained`：只去了一个会话就回来，页面一直挂着（`RetainedViews` 用 `Activity` 藏着）；
 * - `evicted`：连着去了三个会话，这一页被挤出去卸载了，回来是重新挂上。
 *
 * 每帧取正在写的那段正文的字数，和回来那一刻上游已经发出的字数对照。
 *
 * 用法：LABEL=before node --experimental-strip-types e2e/stream-switch-probe.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume切换会话流式测试");
const LABEL = process.env.LABEL ?? "run";
const PORT = 9861;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const STREAM = "stream-switch";
const OTHERS = ["other-1", "other-2", "other-3"];

/** 每 40ms 来 6 个字（每秒 150 字），够写 30 秒，两种回来都在写的中途。 */
const REPLY = Array.from({ length: 90 }, (_, at) => `第 ${at + 1} 句：这是一条还在写的回复，切走再切回来时看它怎么出现。`).join("");
const CHUNK = 6;
const EVERY = 40;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emitter = (res: ServerResponse) => (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

/** 上游已经发出去的字数。 */
let sent = 0;

function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		req.on("data", () => {});
		req.on("end", async () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const emit = emitter(res);
			emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			const chars = Array.from(REPLY);
			for (let at = 0; at < chars.length && !res.destroyed; at += CHUNK) {
				emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: chars.slice(at, at + CHUNK).join("") } });
				sent = Math.min(chars.length, at + CHUNK);
				await wait(EVERY);
			}
			emit("content_block_stop", { index: 0 });
			emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
			emit("message_stop", {});
			res.end();
		});
	});
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const session = (id: string, title: string, at: number) => {
		const meta = { id, title, cwd, projectId, projectName: "切换", createdAt: at, updatedAt: at + 1, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
		return { meta, records: [
			{ type: "meta" as const, meta, seq: 0, ts: at },
			{ type: "message" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: `${title}：先说点别的` }], timestamp: at }, seq: 1, ts: at },
			{ type: "message" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: `${title}之前的回答。` }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop" as const, timestamp: at + 1 }, seq: 2, ts: at + 1 },
			{ type: "meta" as const, meta, seq: 3, ts: at + 1 },
		] };
	};
	seedSessions(home, [session(STREAM, "正在写的会话", 100), ...OTHERS.map((id, at) => session(id, `别的会话 ${at + 1}`, 10 + at * 10))]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "切换", pinned: true, lastOpenedAt: 1 }],
	}));
}

/** 每一绘制帧：时刻、正在写的那段正文有几个字（不在这个会话上记 -1）。 */
const RECORD = `(() => {
	window.__stop = false;
	const log = window.__frames = [];
	const start = window.__start = performance.now();
	const length = () => {
		const page = document.querySelector('main [data-view="${STREAM}"][data-active="true"]');
		if (!page) return -1;
		const proses = page.querySelectorAll(".prose-dw");
		const prose = proses[proses.length - 1];
		return prose && prose.textContent.includes("第 1 句") ? Array.from(prose.textContent).length : 0;
	};
	const channel = new MessageChannel();
	channel.port1.onmessage = () => log.push([Math.round(performance.now() - start), length()]);
	const tick = () => {
		channel.port2.postMessage(0);
		if (!window.__stop) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`;

type Row = [at: number, length: number];

async function measure(app: RunningApp, tag: string, away: string[], awayMs: number, out: string[]): Promise<boolean> {
	for (const id of away) {
		await openSession(app, id);
		await pause(awayMs / away.length);
	}
	await app.evaluate(RECORD);
	const sentAtClick = sent;
	const clickAt = await app.evaluate<number>("performance.now() - window.__start");
	await openSession(app, STREAM);
	await pause(1500);
	await app.evaluate("window.__stop = true");
	const rows = (await app.evaluate<Row[]>("window.__frames")).filter((row) => row[0] >= clickAt);
	const shown = rows.filter((row) => row[1] >= 0);
	const first = shown[0];
	const steps = shown.slice(1).map((row, at) => row[1] - shown[at][1]);
	const caught = shown.find((row) => row[1] >= sentAtClick - CHUNK * 2);
	const pass = first !== undefined && first[1] >= sentAtClick - CHUNK * 2 && Math.max(...steps) <= 40;
	out.push(
		`${LABEL}_${tag}: 切回时上游已发 ${sentAtClick} 字；回来第一帧画出 ${first?.[1] ?? "?"} 字` +
			`，追上已发的字用了 ${caught && first ? caught[0] - first[0] : "∞"}ms，之后单帧最多长 ${Math.max(...steps)} 字 → ${pass ? "通过" : "不通过"}`,
		`  前 12 帧字数：${shown.slice(0, 12).map((row) => row[1]).join(" ")}`,
	);
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${tag}_回来后.png`), Buffer.from(image.data, "base64"));
	return pass;
}

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-stream-switch-"));
await seed(home, address.port);
const frames: Frame[] = [];
const lines: string[] = [];
let passed = 0;
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	// 三个别的会话先各进一次：之后来回切都是读过盘的，量的只是正文怎么出现。
	for (const id of OTHERS) {
		await openSession(app, id);
		await pause(300);
	}
	await openSession(app, STREAM);
	await pause(600);
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,"写一段长的");field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
	await until(app, `document.querySelector("main").innerText.includes("第 3 句")`, 5000);
	await pause(1500);
	if (await measure(app, "retained", [OTHERS[0]], 3000, lines)) passed++;
	await pause(1500);
	if (await measure(app, "evicted", OTHERS, 3600, lines)) passed++;
	console.log(lines.join("\n"));
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_读数.txt`), `${lines.join("\n")}\n`);
} finally {
	await stopRecording?.();
	if (frames.length > 1) await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_切走再切回_${passed}of2.mp4`));
	await app?.stop();
	model.close();
	await rm(home, { recursive: true, force: true });
	console.log(`→ ${OUT_DIR}`);
}
