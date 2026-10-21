/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 写完了、在排队的命令：标题是它的说明，不计时，也不说在等输出；真正开跑才从 0 计。
 *
 * 工具等整条回复写完才执行。一条 bash 后面跟着一个长 `write` 时，bash 写完要等 write 生成完——那段
 * 没有运行记录，卡片从前说的是「执行命令 12s · 等待输出…」，而命令一毫秒都还没跑。
 *
 * 模型是本地一个假的 Anthropic 端点：先一口气写完 bash，再用约 8 秒把 write 一段段吐出来。命令是真的，
 * 里面 `sleep` 2.5 秒，让「在跑」那一段也看得清。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/tool-queue-demo.ts [输出目录] [文件名标签]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume工具卡排队状态");
const label = process.argv[3] ?? "改动后";
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9837;
const DESCRIPTION = "复制界面要用的图标";
const COMMAND = "mkdir -p assets/icons && touch assets/icons/{americano,latte,croissant,coin}.png && sleep 2.5 && ls assets/icons";
const STREAM_MS = 8000;

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: unknown[] };
			const last = JSON.stringify(body.messages.at(-1));
			if (last.includes("tool_result")) say(res, "图标复制好了，样张脚本也写好了。");
			else if (last.includes("图标")) void queue(res);
			else say(res, "好，说吧。");
		});
	});
}

const emit = (res: ServerResponse, type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

function say(res: ServerResponse, text: string) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	emit(res, "message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	emit(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	emit(res, "content_block_stop", { index: 0 });
	emit(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
	emit(res, "message_stop", {});
	res.end();
}

/** bash 一口气写完；write 的内容一段段慢慢来，整条回复要到它写完才结束。 */
async function queue(res: ServerResponse) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	emit(res, "message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: `bash-${Date.now()}`, name: "bash", input: {} } });
	emit(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: COMMAND, description: DESCRIPTION }) } });
	emit(res, "content_block_stop", { index: 0 });
	emit(res, "content_block_start", { index: 1, content_block: { type: "tool_use", id: `write-${Date.now()}`, name: "write", input: {} } });
	emit(res, "content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"scripts/sample.gd","content":"extends Node3D\\n' } });
	const chunks = 40;
	for (let i = 0; i < chunks; i++) {
		await pause(STREAM_MS / chunks);
		if (res.destroyed) return;
		emit(res, "content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: `func step_${i}():\\n\\tpass\\n` } });
	}
	emit(res, "content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '"}' } });
	emit(res, "content_block_stop", { index: 1 });
	emit(res, "message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 400 } });
	emit(res, "message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(join(cwd, "scripts"), { recursive: true });
	await writeFile(join(cwd, "README.md"), "# tool queue\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 760, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		autoSummarizeTitle: false,
		projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "排队的命令", pinned: true, lastOpenedAt: 1 }],
	}));
}

/** bash 那张卡此刻在屏幕上是什么样：行上的字、有没有在走秒、展开的那一块写着什么。 */
const BASH_CARD = `(() => {
	const card = document.querySelector('main [data-ly-tool]');
	if (!card) return null;
	const row = card.querySelector('.ly-flow-row');
	const body = card.querySelector('.rounded-lg');
	const title = row?.innerText.replace(/\\s+/g, ' ').trim() ?? '';
	return {
		title,
		seconds: title.match(/(\\d+)s$/) ? Number(title.match(/(\\d+)s$/)[1]) : null,
		glide: Boolean(row?.querySelector('.ly-glide')),
		status: card.getAttribute('data-ly-tool'),
		expandable: Boolean(card.querySelector('button[aria-expanded]')),
		body: body?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
	};
})()`;
interface Card { title: string; seconds: number | null; glide: boolean; status: string; expandable: boolean; body: string }

/** write 那张卡的那一行：还在写时标题带路径，行尾说写了几行。 */
const WRITE_ROW = `document.querySelectorAll('main [data-ly-tool]')[1]?.querySelector('.ly-flow-row')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`;
const linesOf = (row: string) => Number(row.match(/已写 (\d+) 行/)?.[1] ?? NaN);

const server = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const frames: Frame[] = [];

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	const page = app;
	stopRecording = await startRecording(PORT, frames);
	await page.evaluate("document.fonts.ready");
	const card = () => page.evaluate<Card | null>(BASH_CARD);
	// 没开跑的卡不能展开，开跑之后才点得开。
	const reopen = async () => {
		if (await page.evaluate<boolean>(`Boolean(document.querySelector('main [data-ly-tool] .rounded-lg'))`)) return;
		await click(page, "main [data-ly-tool] button[aria-expanded]");
		await pause(500);
	};
	const shot = async (name: string) => {
		const picture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${label}_${name}.png`), Buffer.from(picture.data, "base64"));
	};

	// 首页的输入框就落在这个项目上。先说一句把会话建起来：要看的是已有会话里的一轮，和用户遇到的一样。
	await pause(800);
	await type(page, "main textarea", "先打个招呼");
	await press(page, "Enter", 13);
	await until(page, `document.querySelector('main')?.innerText.includes('好，说吧')`, 1200);
	await pause(800);

	await type(page, "main textarea", "把界面要用的图标复制过来，再写一份样张脚本");
	await pause(500);
	await press(page, "Enter", 13);

	// 一、bash 写完了、write 还在写：它在排队。
	// bash 和 write 同属一段活（终端、改文件合在一起），外面是这一段的那一行，展开才是每一次调用自己的卡。
	await until(page, `document.querySelector('main [data-ly-step]')`, 1200);
	const appeared = Date.now();
	await pause(1500);
	const folded = await page.evaluate<string>(`document.querySelector('main [data-ly-step] .ly-flow-row')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
	await shot("01_排队中_收起");
	check("收着的那一段，那一行也说在写哪个文件、写了几行", folded.includes("sample.gd") && linesOf(folded) > 0, folded);
	if (!(await page.evaluate<boolean>(`Boolean(document.querySelector('main [data-ly-tool]'))`))) await click(page, "main [data-ly-step] > button[aria-expanded]");
	await until(page, `document.querySelectorAll('main [data-ly-tool]').length >= 2`, 600);
	await pause(1200);
	const queued = await card();
	assert.ok(queued, "bash 那张卡没画出来");
	const early = await page.evaluate<string>(WRITE_ROW);
	await pause(1200);
	const later = await page.evaluate<string>(WRITE_ROW);
	await shot("02_排队中_写文件在长");
	check("排队时标题是模型写的说明，不是「执行命令」", queued.title.startsWith(DESCRIPTION), queued.title);
	check("排队时不计时", queued.seconds === null, { title: queued.title, 已出现ms: Date.now() - appeared });
	check("排队时不能展开", !queued.expandable && queued.body === "", { expandable: queued.expandable, body: queued.body });
	check("排队时行上照旧有流光——它确实在忙", queued.glide, queued.glide);
	check("写着的文件标题带上路径", early.includes("sample.gd"), early);
	check("写着的文件行尾说写了几行，而且在涨", linesOf(early) > 0 && linesOf(later) > linesOf(early), { early, later });

	// 二、回复写完、bash 开跑：从 0 计起。
	await until(page, `/\\d+s$/.test(document.querySelector('main [data-ly-tool] .ly-flow-row')?.innerText.trim() ?? '')`, 1200);
	const queuedFor = Date.now() - appeared;
	const startedRow = await card();
	await reopen();
	const running = { ...(await card())!, seconds: startedRow?.seconds ?? null };
	assert.ok(running);
	await pause(700);
	await shot("03_真正在跑");
	check("开跑后的秒数从它真正开始算，不含排队的那几秒", running.seconds !== null && running.seconds <= 2 && queuedFor > 6000, { 秒数: running.seconds, 排队ms: queuedFor });
	check("开跑后标题没变", running.title.startsWith(DESCRIPTION), running.title);
	check("开跑后能展开，展开说在等输出", running.expandable && running.body.includes("等待输出"), running.body.slice(-40));

	// 三、跑完。
	await until(page, `document.querySelector('main [data-ly-tool]')?.getAttribute('data-ly-tool') === 'done'`, 1200);
	await until(page, `document.querySelector('main')?.innerText.includes('样张脚本也写好了')`, 1200);
	await pause(600);
	await reopen();
	await pause(600);
	const done = await card();
	assert.ok(done);
	await shot("04_跑完");
	check("跑完后标题还是那句说明，不再计时", done.title === DESCRIPTION, done.title);
	check("跑完后展开是结果", done.body.includes("americano.png") && !done.body.includes("等待输出"), done.body.slice(-60));
	await pause(1000);
} catch (error) {
	if (app) {
		const picture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${label}_失败现场.png`), Buffer.from(picture.data, "base64"));
		console.log(await app.evaluate<string>(`[...document.querySelectorAll('main .ly-flow-row')].map((row) => row.parentElement.parentElement.outerHTML.slice(0, 1500)).join('\\n----\\n')`));
	}
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
const video = join(out, `${stamp}_${label}_排队的命令_${passed}of${checks.length}.mp4`);
await encode(frames, video);
console.log(`\n${passed}/${checks.length} 通过\n${video}`);
if (passed !== checks.length) process.exitCode = 1;
