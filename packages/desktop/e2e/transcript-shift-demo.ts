/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 发第二条消息、一轮答完收尾，这两个时刻转录都不该挪动。
 *
 * `node --experimental-strip-types e2e/transcript-shift-demo.ts [输出目录]`，先 `pnpm build`。
 *
 * - 第二个问题一发出，左边的问题导航条出现。正文的左右内边距从前跟着它切换，整段转录当帧往右挪。
 * - 答完那一刻，运行行在消息定稿那次提交就收起，而回答底下的操作行要等 `running` 落下才长出来；
 *   隔着这一次提交，贴底的转录先掉下去一行、再被滚回来。
 *
 * 本地脚本模型答两轮，第二轮回答足够长、把转录顶到贴底。消息定稿（`message_end`）和这一轮收尾
 * （`agent_end`）之间挂一个睡 0.4 秒的 Stop 钩子：真实模型在这两件事之间还有落盘、钩子这些活，
 * 两次提交隔着好几帧；本地模型没有它们，两件事在同一帧到，那一下就量不出来。逐帧记第一条回答的左边缘和第二个问题
 * 那个气泡的纵坐标——回答流式输出时字被拆在多个节点里，拿它的第一行当锚找不到。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const MODEL_PORT = 9583;
const PORT = 9474;
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume转录跳动测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const HELLO = "你好！有什么我可以帮你处理的吗？";
const ASK = "你有哪些工具";
const HEAD = "我可以使用这些工具：";
const LINES = Array.from({ length: 30 }, (_, i) => `- 工具 ${i + 1}：读取、搜索、创建和修改项目里的文件。`);
const END = "以上就是全部工具。";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** 按请求内容挑回复：标题生成这类旁路请求也会打到同一个模型上。 */
function pick(body: string): { thinkMs: number; chunks: string[] } {
	// 下一步建议的旁路请求：答一句短的，让输入框里的灰字也在画面里换一次。
	if (body.includes("Match how the user writes")) return { thinkMs: 0, chunks: ["继续讲讲"] };
	const request = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
	const last = request.messages?.findLast((message) => !JSON.stringify(message.content).includes("<env>"));
	const content = JSON.stringify(last?.content ?? "");
	if (content.includes("有哪些工具")) return { thinkMs: 800, chunks: [`${HEAD}\n\n`, ...LINES.map((line) => `${line}\n`), `\n${END}`] };
	if (content.includes("你好")) return { thinkMs: 600, chunks: [HELLO] };
	return { thinkMs: 0, chunks: ["演示"] };
}

function startModel(): Server {
	let id = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString()));
		req.on("end", async () => {
			const step = pick(body);
			const n = id++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${n}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			let index = 0;
			if (step.thinkMs > 0) {
				sse(res, { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
				for (let at = 0; at < step.thinkMs; at += 100) {
					sse(res, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "想。" } });
					await pause(100);
				}
				sse(res, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
				sse(res, { type: "content_block_stop", index: index++ });
			}
			sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
			for (const chunk of step.chunks) {
				sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
				await pause(90);
			}
			sse(res, { type: "content_block_stop", index });
			sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } });
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 760, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "local",
					name: "Local",
					baseUrl: `http://127.0.0.1:${MODEL_PORT}`,
					api: "anthropic-messages",
					apiKey: "not-a-key",
					enabled: true,
					models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: false, supportsTools: true }],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "local/scripted",
			permissionMode: "full",
			thinking: "medium",
			// 推理行画出来：不画时这一轮收尾会从「有过程」变成平铺，回答行换父元素重挂，操作行的进场动画就走不到。
			showThinking: true,
			nextPromptSuggestions: true,
			retryAttempts: 1,
			hooks: { events: { Stop: [{ hooks: [{ type: "command", command: "sleep 0.4" }] }] } },
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "light" },
		}),
	);
}

/** 每一帧都记：第一条回答的左边缘、第二个问题气泡的纵坐标、导航条在不在、还在不在跑。 */
const WATCH = `(() => {
	const find = (text) => document.evaluate("//main//*[contains(text(), " + JSON.stringify(text) + ")]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
	const log = [];
	let row = null;
	const tick = () => {
		const line = find("工具 1：");
		if (line && !row) row = line.closest('[class*="group/msg"]');
		const hello = find(${JSON.stringify(HELLO)});
		const ask = find(${JSON.stringify(ASK)});
		const main = document.querySelector("main");
		log.push({
			t: performance.now(),
			x: hello ? hello.getBoundingClientRect().left : null,
			y: ask ? ask.getBoundingClientRect().top : null,
			nav: Boolean(document.querySelector("nav.ly-question-nav")),
			running: Boolean(document.querySelector('main button[aria-label="停止"]')),
			same: row ? row.isConnected : null,
			tr: document.querySelector("main .ly-transcript")?.getBoundingClientRect().height ?? null,
			acts: [...document.querySelectorAll('main div.h-6[class*="group-hover/msg"]')].map((el) => el.getBoundingClientRect().height.toFixed(1) + (el.classList.contains("ly-actions-in") ? "*" : "")).join(","),
		});
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	window.__shiftLog = log;
	return true;
})()`;

type Entry = { same: boolean | null; t: number; x: number | null; y: number | null; nav: boolean; running: boolean; tr: number | null; acts: string };

await mkdir(OUT_DIR, { recursive: true });
const model = startModel();
const app = await startApp({ port: PORT, seed });
const frames: Frame[] = [];
const shoot = async (name: string) => {
	const png = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(png.data, "base64"));
};
const STOPPED = `!document.querySelector('main button[aria-label="停止"]')`;
const shows = (text: string) => `document.querySelector("main").innerText.includes(${JSON.stringify(text)})`;

try {
	await until(app, `document.querySelector("main textarea")`);
	const stop = await startRecording(PORT, frames);
	await pause(800);

	console.log("\n第一轮：你好");
	await type(app, "main textarea", "你好");
	await press(app, "Enter", 13);
	await until(app, `${shows(HELLO)} && ${STOPPED}`, 1200);
	await pause(1200);
	await shoot("01_一个问题_没有导航条");

	await app.evaluate(WATCH);
	console.log("\n第二轮：你有哪些工具");
	await type(app, "main textarea", ASK);
	await press(app, "Enter", 13);
	await until(app, `document.querySelector("nav.ly-question-nav")`, 600);
	await pause(600);
	await shoot("02_第二个问题发出_导航条出现");
	await until(app, `${shows(END)} && ${STOPPED}`, 2400);
	await pause(3500);
	await shoot("03_第二轮答完");
	await stop();

	const log = await app.evaluate<Entry[]>("window.__shiftLog");
	const xs = log.filter((e) => e.x !== null).map((e) => e.x as number);
	const navAt = log.findIndex((e) => e.nav);
	check("第二个问题发出后导航条出现", navAt >= 0, navAt >= 0 ? `第 ${navAt} 帧出现` : "从未出现");
	const drift = Math.max(...xs) - Math.min(...xs);
	check("导航条出现前后，第一条回答的左边缘纹丝不动", drift <= 0.5, `左边缘取值 ${[...new Set(xs.map((x) => x.toFixed(1)))].join(" → ")}px，最大差 ${drift.toFixed(1)}px`);

	// 第二轮停止键消失的那一帧；前后各看 1.5 秒。
	const startedAt = log.findIndex((e) => e.running);
	const stoppedAt = log.findIndex((e, i) => i > startedAt && !e.running);
	const tail = log.filter((e) => e.y !== null && Math.abs(e.t - log[stoppedAt].t) <= 1500);
	let drop = 0;
	let dropAt = 0;
	for (let i = 1; i < tail.length; i++) {
		const step = (tail[i].y as number) - (tail[i - 1].y as number);
		if (step > drop) { drop = step; dropAt = tail[i].t; }
	}
	// 运行行出、操作行进在同一帧，两者一样高（28px），收尾那一帧一像素也不该动。
	check("答完收尾时转录一帧也没有往下掉", drop <= 0.5, drop > 1 ? `停止键消失后 ${(dropAt - log[stoppedAt].t).toFixed(0)}ms 一帧下沉 ${drop.toFixed(1)}px` : `最大单帧下沉 ${drop.toFixed(1)}px`);
	const before = log[stoppedAt - 1].y as number;
	const after = tail.at(-1)?.y as number;
	check("收尾前后转录停在原地", Math.abs(after - before) <= 0.5, `最后一帧还在跑 ${before.toFixed(1)}px → 停稳 ${after.toFixed(1)}px，差 ${(after - before).toFixed(1)}px`);

	console.log("\n第二轮开始到收尾后 3 秒，转录每一次往下挪（相对停止键消失那一帧）：");
	for (let i = 1; i < log.length; i++) {
		const [a, b] = [log[i - 1], log[i]];
		if (a.y !== null && b.y !== null && b.y - a.y > 0.5) console.log(`   ${(b.t - log[stoppedAt].t).toFixed(0).padStart(6)}ms  下沉 ${(b.y - a.y).toFixed(1)}px  跑着${b.running ? "✓" : "·"}  转录高${a.tr?.toFixed(1)}→${b.tr?.toFixed(1)}`);
	}

	console.log("\n收尾附近逐帧纵坐标（相对停止键消失那一帧）：");
	for (const e of log.slice(Math.max(0, stoppedAt - 4), stoppedAt + 14)) console.log(`   ${(e.t - log[stoppedAt].t).toFixed(0).padStart(5)}ms  y=${e.y?.toFixed(1)}  跑着${e.running ? "✓" : "·"}  转录高${e.tr?.toFixed(1)}  操作行[${e.acts}]  回答行同一个=${e.same}`);

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_发第二条与答完收尾不跳动_${passed}of${checks.length}.mp4`), 30, 1200);
	console.log(`\n${passed}/${checks.length} 通过，产物在 ${OUT_DIR}`);
	process.exitCode = passed === checks.length ? 0 : 1;
} finally {
	await app.stop();
	await new Promise((resolve) => model.close(() => resolve(null)));
}
