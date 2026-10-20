/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一条正文流式写到底部时，贴底跟随的转录每一帧挪了多少、最新的字有没有被压到视口下面。
 *
 * 人说的「一顿一顿」有三个来源，分开量：
 * - 视口每帧挪的距离（`scrollTop` 的逐帧差）：挪得匀是顺，忽快忽慢、一帧跳十几像素是顿；
 * - 已经实了的字离可见下沿多远（`sink`）：正数是被挡住了，负数是底下留的空白；
 * - 帧间隔：超过 32ms 就是丢了一帧。
 *
 * 上游的节奏由 `CADENCE` 选：`smooth` 每 24ms 来 4 个字（像按 token 流的服务商），`burst` 每 600ms
 * 倒进来 150 个字（像 DeepSeek 经中转那样一阵一停），`fast` 每帧 14 个字（每秒八百多字的快模型）。
 * 同一条剧本改前改后各跑一次（`LABEL`），两份输出对照。
 *
 * 每帧的读数在画完之后取（rAF 里往 MessageChannel 投一个任务），不在 rAF 里读：那时跟随还没写、
 * 内容已经长了，读到的是一个从没画出来过的状态。
 *
 * 用法：CADENCE=smooth LABEL=before node --experimental-strip-types e2e/stream-follow-probe.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume流式跟随测试");
const LABEL = process.env.LABEL ?? "run";
const CADENCE = (process.env.CADENCE ?? "smooth") as "smooth" | "burst" | "fast";
const PORT = 9860;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "stream-follow";
const END = "到此为止。";

/** 一条像真回复的正文：段落、标题、列表、表格、代码块都有，台阶的大小各不相同。 */
const REPLY = [
	"先说结论：这次卡顿不是渲染慢，而是跟随滚动在内容每长一行的时候当帧写掉了一截位置。下面按三个来源分别讲。",
	"## 到达的节奏",
	"上游的字不是匀速来的。有的服务商每个 token 一帧，有的攒几百毫秒一次倒出一两百字。照原样画，就是停住、整句蹦出来、再停住。把字先攒起来，按最近一秒的平均速度放出去，上游的停顿就被缓冲带吃掉了，屏幕上看到的是一条连续的流。",
	"要注意的几点：",
	"- 速度按平均算，不按这一批来得多快算，否则积压会在停顿之前放空；",
	"- 积压超过约七百毫秒要加速，屏幕不能越落越远；",
	"- 写完以后剩下的字照常放完，不在结束那一刻整段蹦出来；",
	"- 拉丁文按词放，半个词不放出来，行尾就不会先打半个再跳到下一行。",
	"## 版面的台阶",
	"正文每换一行，版面高一行；表格每来一行、代码块一开口，高几十像素。跟随的目标本身就是台阶状的，视口要平滑就得滤波，滤波就有落后。",
	"| 来源 | 台阶 | 频率 |",
	"| --- | --- | --- |",
	"| 换行 | 24px | 每行一次 |",
	"| 段落间距 | 12px | 每段一次 |",
	"| 表格行 | 40–60px | 每行一次 |",
	"| 代码块开口 | 60px 以上 | 每块一次 |",
	"落后的那一截落在哪，决定了它挡不挡字。回复底下本来就有一行看不见的运行行和一段留白，字停在它们上面，落后几十像素也还在可见区里。",
	"```ts",
	"export function advance(spring: Spring, target: number, omega: number, dt: number): void {",
	"\tconst offset = spring.at - target;",
	"\tconst decay = Math.exp(-omega * dt);",
	"\tconst pull = spring.speed + omega * offset;",
	"\tspring.at = target + (offset + pull * dt) * decay;",
	"\tspring.speed = (spring.speed - omega * pull * dt) * decay;",
	"}",
	"```",
	"## 每帧的成本",
	"几百个字各带一个动画，一帧就要五十多毫秒。同一帧放出来的字合用一个淡入，在飞的不过十来个，动画的数量少一个数量级。",
	"最后一段只是为了把转录再推长一点，让收尾的那几帧也量得到：字停了以后页面不该再往下蹭，操作行长出来的那一刻也不该跳。",
	END,
].join("\n\n");

const PLAN = {
	smooth: { chunk: 4, every: 24 },
	burst: { chunk: 150, every: 600 },
	fast: { chunk: 14, every: 16 },
}[CADENCE];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emitter = (res: ServerResponse) => (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

/** 上游最后一个字发出去的时刻（`Date.now()`），和页面里的时钟对得上。 */
let lastSentAt = 0;

function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		req.on("data", () => {});
		req.on("end", async () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const emit = emitter(res);
			emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			await wait(600);
			const chars = Array.from(REPLY);
			for (let at = 0; at < chars.length; at += PLAN.chunk) {
				emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: chars.slice(at, at + PLAN.chunk).join("") } });
				lastSentAt = Date.now();
				await wait(PLAN.every);
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
	await writeFile(join(cwd, "a.ts"), "export const a = 1\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "流式跟随", cwd, projectId, projectName: "滚动", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	// 历史要比一屏长：贴着底部跟随是从一开始就在滚的状态。
	const history = Array.from({ length: 14 }, (_, at) => `第 ${at + 1} 段：之前聊过的内容，占一点高度，让转录一开始就比一屏长。`).join("\n\n");
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "先说点别的" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: history }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "滚动", pinned: true, lastOpenedAt: 1 }],
	}));
}

/**
 * 每一绘制帧：时刻、`scrollTop`、离底多少、最后一个实了的字离可见下沿多远（正数是被挡住）。
 *
 * 「实了的字」从后往前找第一个不透明的淡入 span；一个也没有就取最后一个 span 前面那个字；没有 span 就取
 * 最后一块的末尾。还透明着的字不算：先排版后显现的版本里它们在版面里，但人看不见。
 */
const RECORD = `(() => {
	const el = [...document.querySelectorAll("main .ly-scroll-view")].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
	const log = window.__frames = [];
	window.__t0 = Date.now();
	const start = performance.now();
	const edge = () => el.getBoundingClientRect().bottom;
	const shownBottom = () => {
		const proses = el.querySelectorAll(".prose-dw");
		const prose = proses[proses.length - 1];
		if (!prose) return null;
		const spans = prose.querySelectorAll(".ly-fade-char");
		for (let i = spans.length - 1; i >= 0; i--) {
			if (Number.parseFloat(getComputedStyle(spans[i]).opacity) >= 0.5) {
				const rects = spans[i].getClientRects();
				return rects.length ? rects[rects.length - 1].bottom : spans[i].getBoundingClientRect().bottom;
			}
		}
		const range = document.createRange();
		if (spans.length) {
			const prev = spans[0].previousSibling;
			if (prev && prev.nodeType === 3 && prev.length) {
				range.setStart(prev, prev.length - 1);
				range.setEnd(prev, prev.length);
				const rect = range.getClientRects()[0];
				if (rect) return rect.bottom;
			}
			return spans[0].getBoundingClientRect().top;
		}
		range.selectNodeContents(prose.lastElementChild ?? prose);
		let bottom = -Infinity;
		for (const rect of range.getClientRects()) if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
		return Number.isFinite(bottom) ? bottom : null;
	};
	const channel = new MessageChannel();
	channel.port1.onmessage = () => {
		if (!el) return;
		const shown = shownBottom();
		log.push([
			Math.round(performance.now() - start),
			Math.round(el.scrollTop * 10) / 10,
			Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
			shown === null ? null : Math.round((shown - edge()) * 10) / 10,
		]);
	};
	const tick = () => {
		channel.port2.postMessage(0);
		if (!window.__stop) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return Boolean(el);
})()`;

type Row = [at: number, top: number, gap: number, sink: number | null];

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-stream-follow-"));
await seed(home, address.port);
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
let summary = "";
const tag = `${LABEL}_${CADENCE}`;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(800);
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,"讲讲卡顿");field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
	await pause(300);
	const found = await app.evaluate<boolean>(RECORD);
	if (!found) throw new Error("找不到转录的滚动区");
	// 写到一半拍一张：底下留了多少空、有没有字被挡。
	await until(app, `document.querySelector("main").innerText.includes("版面的台阶")`, 3000);
	const mid = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${tag}_写到一半.png`), Buffer.from(mid.data, "base64"));
	await until(app, `document.querySelector("main").innerText.includes(${JSON.stringify(END)}) && !document.querySelector("main .ly-fade-char")`, 3000);
	const shownAt = await app.evaluate<number>("Date.now() - window.__t0");
	const t0 = await app.evaluate<number>("window.__t0");
	await until(app, `!document.querySelector('button[aria-label="停止"]')`, 1200);
	await pause(800);
	await app.evaluate("window.__stop = true");
	const rows = await app.evaluate<Row[]>("window.__frames");

	const gaps = rows.slice(1).map((row, i) => row[0] - rows[i][0]);
	const steps = rows.slice(1).map((row, i) => row[1] - rows[i][1]);
	const lurches = steps.slice(1).map((step, i) => Math.abs(step - steps[i]));
	// 还在写的那一段：从第一次有字到最后一个字实了。
	const writing = rows.filter((row) => row[3] !== null && row[0] <= shownAt);
	const sinks = writing.map((row) => row[3] as number);
	const hidden = sinks.filter((sink) => sink > 0);
	const settled = rows.at(-1)?.[2] ?? -1;
	const endLag = shownAt - (lastSentAt - t0);
	// 字停了以后页面还挪了多少：最后一个字实了之后 `scrollTop` 的总变化。
	const after = rows.filter((row) => row[0] > shownAt);
	const drift = after.length > 1 ? after.at(-1)![1] - after[0][1] : 0;
	const lines = [
		`${tag}: 帧 ${rows.length}，写了 ${fmt(shownAt / 1000)}s，上游写完到最后一个字实了 ${Math.round(endLag)}ms`,
		`  帧间隔 p50 ${fmt(percentile(gaps, 0.5))} / p95 ${fmt(percentile(gaps, 0.95))} / 最长 ${fmt(Math.max(...gaps))}ms，>32ms 的 ${gaps.filter((g) => g > 32).length} 帧`,
		`  每帧位移 p50 ${fmt(percentile(steps, 0.5))} / p95 ${fmt(percentile(steps, 0.95))} / 最大 ${fmt(Math.max(...steps))}px，>8px 的 ${steps.filter((s) => s > 8).length} 帧，>16px 的 ${steps.filter((s) => s > 16).length} 帧，往回的 ${steps.filter((s) => s < -0.5).length} 帧`,
		`  相邻两帧速度差 p95 ${fmt(percentile(lurches, 0.95))} / 最大 ${fmt(Math.max(...lurches))}px`,
		`  已实的字被挡：${hidden.length} 帧，最深 ${fmt(hidden.length ? Math.max(...hidden) : 0)}px；底下留白 p50 ${fmt(-percentile(sinks, 0.5))} / 最多 ${fmt(-Math.min(...sinks))}px`,
		`  字停之后页面又挪了 ${fmt(drift)}px，结束时离底 ${settled}px`,
	];
	summary = lines.join("\n");
	console.log(summary);
	await writeFile(join(OUT_DIR, `${STAMP}_${tag}_每帧.json`), JSON.stringify({ summary: lines, rows }));
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${tag}_结束.png`), Buffer.from(image.data, "base64"));
} finally {
	await stopRecording?.();
	if (frames.length > 1) await encode(frames, join(OUT_DIR, `${STAMP}_${tag}_流式跟随.mp4`));
	await app?.stop();
	model.close();
	console.log(summary ? `→ ${OUT_DIR}` : "没有量到");
}
