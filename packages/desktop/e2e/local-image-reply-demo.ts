/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 回复里的本地图片直接画出来；同一路径被覆盖后，新回复和文件面板画的是新图。
 *
 * 飞书 CLI 那一轮的原样：两次授权都把二维码写到同一个 `feishu-auth-qr.png`，第二条回复里
 * 只有一个文件链接，点开面板还是第一次那张。地址只由路径拼成，Chromium 对同一地址的图整页复用。
 *
 * 一个会话，两条回复：存好的那条指着 640×360 的图；把文件原地换成 320×320，再让假端点现吐一条
 * 指着同一路径的回复。端点写法同 `linked-file-demo.ts`。
 *
 * 用法：node --experimental-strip-types e2e/local-image-reply-demo.ts
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = join(homedir(), "Desktop", "Plume回复内联图片测试");
const PORT = 9433;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const TITLE = "飞书授权";

let app: RunningApp;
let qr = "";
let relayPort = 0;

const reply = (label: string) => `也可以使用下面的二维码：\n\n![飞书授权二维码](${qr})\n\n[${label}](${qr})`;

/** 只会说一句话的模型：再给一次同一路径的二维码。 */
function relay() {
	return createServer(async (req, res) => {
		for await (const _ of req);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		for (const piece of reply("新二维码文件").match(/.{1,8}/gsu) ?? []) {
			send({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
			await pause(30);
		}
		send({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		send({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } });
		res.end("data: [DONE]\n\n");
	});
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

/** ffmpeg 现做的真 PNG；两次尺寸不同，量 `naturalWidth` 就知道画的是哪一张。 */
function picture(source: string): void {
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", source, "-frames:v", "1", qr], { stdio: "ignore" });
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	qr = join(project, "feishu-auth-qr.png");
	await mkdir(project, { recursive: true });
	picture("testsrc=s=640x360");

	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			uiLocale: "zh-CN",
			permissionMode: "full",
			projectMemory: false,
			thinking: "off",
			autoSummarizeTitle: false,
			mcpServers: [],
			hooks: [],
			appearance: { reduceMotion: "on" },
			projects: [{ id: projectId, path: project, name: "演示工程", pinned: true, lastOpenedAt: Date.now() }],
			defaultModelId: "fake/linker",
			providers: [{
				id: "fake",
				name: "假端点",
				api: "openai-chat-completions",
				baseUrl: `http://127.0.0.1:${relayPort}/v1`,
				apiKey: "probe-key",
				enabled: true,
				models: [{ id: "fake/linker", providerId: "fake", modelId: "linker", name: "linker", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
			}],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));

	const meta = {
		id: "local-image",
		title: TITLE,
		cwd: project,
		projectId,
		projectName: "演示工程",
		createdAt: 1,
		updatedAt: Date.now(),
		modelId: "fake/linker",
		messageCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		seq: 3,
	};
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: 1, type: "meta", meta },
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: "装一下飞书 cli" }], timestamp: 2 } },
			// 发下一条之前要量上下文，读的是上一条回复的 `usage`；缺了它这一轮在请求发出去之前就失败了。
			{ seq: 3, ts: 3, type: "message", message: { role: "assistant", timestamp: 3, api: "openai-chat-completions", provider: "fake", model: "linker", content: [{ type: "text", text: reply("旧二维码文件") }], usage: meta.usage, stopReason: "stop" } },
		],
	} as never]);
}

async function shot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT_DIR, `${STAMP}_${name}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	console.log(`   · ${file}`);
}

/** 一段时间内轮询，拿到就停；拿不到交回最后一次看到的。 */
async function poll<T>(expression: string, ok: (value: T) => boolean, ms = 8000): Promise<T> {
	const end = Date.now() + ms;
	let value = await app.evaluate<T>(expression);
	while (!ok(value) && Date.now() < end) {
		await pause(200);
		value = await app.evaluate<T>(expression);
	}
	return value;
}

/** 回复里画出来的图，按出现顺序：宽度和地址。 */
const INLINE = `[...document.querySelectorAll('img.ly-md-image')].map((i)=>({w:i.naturalWidth,src:i.getAttribute('src')}))`;
/** 文件面板里那张：不在回复里的 `ly-media:` 图。 */
const PANE = `(()=>{const img=[...document.querySelectorAll('img[src^="ly-media:"]')].find((i)=>!i.classList.contains('ly-md-image'));return img?img.naturalWidth:0;})()`;

/** 点回复里写着这几个字的那个文件链接——真鼠标。 */
async function clickLink(label: string): Promise<void> {
	const { click } = driver(app);
	await app.evaluate(`(()=>{
		document.querySelector('[data-demo-link]')?.removeAttribute('data-demo-link');
		const links = [...document.querySelectorAll('[data-ly-file-link] a')];
		links.findLast((a) => a.textContent.includes(${JSON.stringify(label)}))?.setAttribute('data-demo-link', '');
	})()`);
	await click("[data-demo-link]");
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	const endpoint = relay();
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	relayPort = (endpoint.address() as { port: number }).port;
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const { click, type, submit, settled } = driver(app);
	const stop = await startRecording(PORT, frames);
	try {
		console.log("一、存好的回复：二维码直接画在回复里");
		await pause(1200);
		await app.evaluate(`[...document.querySelectorAll("button")].find((b)=>b.textContent?.includes(${JSON.stringify(TITLE)}))?.setAttribute('data-demo-row','')`);
		await click("[data-demo-row]");
		const first = await poll<{ w: number; src: string }[]>(INLINE, (v) => v.length >= 1 && v[0].w > 0, 20000);
		await pause(1000);
		check("回复里画出了 640 宽的二维码，不再只是一个文件链接", first[0]?.w === 640, JSON.stringify(first));
		check("图片地址带着文件版本", /\?v=\d/.test(first[0]?.src ?? ""), first[0]?.src);
		await shot("01_回复里直接显示二维码");

		await clickLink("旧二维码文件");
		const paneOld = await poll<number>(PANE, (w) => w > 0);
		await pause(1000);
		check("点链接：面板里也是 640 宽的那张", paneOld === 640, String(paneOld));

		console.log("二、文件原地换成 320×320，模型再给一次同一路径");
		picture("smptebars=s=320x320");
		await type("已授权，再给我一次二维码");
		await pause(500);
		await submit();
		await settled();
		const both = await poll<{ w: number; src: string }[]>(INLINE, (v) => v.length >= 2 && v[v.length - 1].w > 0, 15000);
		await pause(1200);
		const latest = both[both.length - 1];
		check("新回复里画的是新图（320 宽）", latest?.w === 320, JSON.stringify(both));
		check("新回复的地址和旧回复不同", Boolean(latest && first[0] && latest.src !== first[0].src), JSON.stringify(both));
		await shot("02_新回复显示新二维码");

		await clickLink("新二维码文件");
		const paneNew = await poll<number>(PANE, (w) => w === 320);
		await pause(1200);
		check("再点链接：面板换成了新图（320 宽）", paneNew === 320, String(paneNew));
		await shot("03_面板显示新二维码");
	} catch (error) {
		await shot("失败现场").catch(() => {});
		console.log(await app.evaluate<string>(`document.body.innerText.slice(0, 800)`).catch(() => ""));
		await app.stop();
		endpoint.close();
		throw error;
	} finally {
		await stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (frames.length > 0) {
		const out = join(OUT_DIR, `${STAMP}_回复内联图片与覆盖刷新_${passed}of${checks.length}.mp4`);
		await encode(frames, out);
		console.log(`视频：${out}`);
	}
	await app.stop();
	endpoint.close();
	process.exitCode = passed === checks.length ? 0 : 1;
}

await main();
