/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 回复里的本地图片什么时候画、什么时候留成链接——每条规则一个例子，在真窗口里逐条量。
 *
 * 一个会话：用户消息里带一张图（不画），模型回复里十种写法，各自标着该是什么结果；最后把二维码
 * 原地换掉，假端点再回一条指向同一路径的回复，量新旧两条各画的是哪一张。端点写法同 `linked-file-demo.ts`。
 *
 * 用法：
 *   node --experimental-strip-types e2e/local-image-rules-demo.ts         逐条量、录屏
 *   node --experimental-strip-types e2e/local-image-rules-demo.ts keep    只造好会话、开一个窗口留给人看
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { electronLaunch, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const KEEP = process.argv[2] === "keep";
const OUT_DIR = join(homedir(), "Desktop", "Plume回复内联图片测试");
const PORT = 9437;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const TITLE = "本地图片显示规则";
const QRCode = createRequire(import.meta.url)("qrcode") as { toFile(path: string, text: string, options: { width: number; margin: number }): Promise<void> };

let app: RunningApp;
let relayPort = 0;
let qr = "";

/** 每一种写法：图片的 alt 就是它的名字，量的时候按它找。 */
const CASES = (home: string, project: string) => [
	{ name: "①绝对路径", shows: true, md: `![①绝对路径](${qr})` },
	{ name: "②相对项目的路径", shows: true, md: "![②相对项目的路径](assets/logo.png)" },
	{ name: "③普通链接语法", shows: false, md: `[③普通链接语法](${qr})` },
	{ name: "④file协议头", shows: false, md: `![④file协议头](file://${qr})` },
	{ name: "⑤波浪号主目录", shows: false, md: "![⑤波浪号主目录](~/feishu-auth-qr.png)" },
	{ name: "⑥只写文件名但文件在子目录", shows: false, md: "![⑥只写文件名但文件在子目录](logo.png)" },
	// 回复里写明的绝对路径，项目外也放行那一个文件——见 `attachment-reads.ts`。
	{ name: "⑦项目外但回复里写了绝对路径", shows: true, md: `![⑦项目外但回复里写了绝对路径](${join(home, "outside", "desktop-shot.png")})` },
	{ name: "⑧用相对路径跳出项目", shows: false, md: "![⑧用相对路径跳出项目](../outside/secret.png)" },
	{ name: "⑨文件不存在", shows: false, md: `![⑨文件不存在](${join(project, "missing.png")})` },
	{ name: "⑩内容不是图片", shows: false, md: `![⑩内容不是图片](${join(project, "broken.png")})` },
];

const reply = (cases: ReturnType<typeof CASES>) =>
	[
		"下面每一段的标题写着该有的结果。",
		...cases.map((c) => `**${c.name}**：应${c.shows ? "显示图片" : "留成链接"}\n\n${c.md}`),
	].join("\n\n");

/** 只会说一句话的模型：再给一次同一路径的二维码。 */
function relay() {
	return createServer(async (req, res) => {
		for await (const _ of req);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		for (const piece of `新的二维码：\n\n![⑫覆盖后的新回复](${qr})`.match(/.{1,8}/gsu) ?? []) {
			send({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
			await pause(30);
		}
		send({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		send({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } });
		res.end("data: [DONE]\n\n");
	});
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	qr = join(project, "feishu-auth-qr.png");
	await mkdir(join(project, "assets"), { recursive: true });
	await mkdir(join(home, "outside"), { recursive: true });
	await QRCode.toFile(qr, "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=8V7W-5LRM", { width: 256, margin: 2 });
	await QRCode.toFile(join(project, "assets", "logo.png"), "assets/logo.png", { width: 160, margin: 2 });
	await QRCode.toFile(join(home, "outside", "desktop-shot.png"), "desktop-shot", { width: 160, margin: 2 });
	await QRCode.toFile(join(home, "outside", "secret.png"), "secret", { width: 160, margin: 2 });
	await writeFile(join(project, "broken.png"), "这不是一张 PNG");

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
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900 }));

	const meta = {
		id: "local-image-rules",
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
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: `⑪用户消息里的图片语法不画：![⑪用户消息](${qr})` }], timestamp: 2 } },
			// 发下一条之前要量上下文，读的是上一条回复的 `usage`；缺了它这一轮在请求发出去之前就失败了。
			{ seq: 3, ts: 3, type: "message", message: { role: "assistant", timestamp: 3, api: "openai-chat-completions", provider: "fake", model: "linker", content: [{ type: "text", text: reply(CASES(home, project)) }], usage: meta.usage, stopReason: "stop" } },
		],
	} as never]);
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

async function shot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT_DIR, `${STAMP}_规则_${name}.png`);
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

/** 这一例在屏幕上是什么：画出来的图（量宽度），还是一段写着它名字的字。 */
const look = (name: string) => `(()=>{
	const img=[...document.querySelectorAll('img')].findLast((i)=>i.alt===${JSON.stringify(name)});
	if(img) return {img:true,w:img.naturalWidth,complete:img.complete};
	return {img:false,text:document.querySelector('main').innerText.includes(${JSON.stringify(name)})};
})()`;

/** 把写着这几个字的那一段滚到屏幕中间。 */
async function reveal(text: string): Promise<void> {
	await app.evaluate(`(()=>{
		const walker=document.createTreeWalker(document.querySelector('main'),NodeFilter.SHOW_TEXT);
		let last=null;
		while(walker.nextNode()) if(walker.currentNode.textContent.includes(${JSON.stringify(text)})) last=walker.currentNode.parentElement;
		last?.scrollIntoView({block:"center"});
	})()`);
	await pause(900);
}

type Look = { img: boolean; w?: number; complete?: boolean; text?: boolean };

async function keep(): Promise<void> {
	const home = "/tmp/plume-image-rules";
	await rm(home, { recursive: true, force: true });
	await mkdir(home, { recursive: true });
	await seed(home);
	const { executable, argv } = electronLaunch();
	const child = spawn(executable, argv, { cwd: join(import.meta.dirname, ".."), env: { ...process.env, PLUME_HOME: home, PLUME_E2E_OFFLINE_CATALOG: "1" }, stdio: "ignore", detached: true });
	child.unref();
	console.log(`已开窗口 pid=${child.pid}，profile=${home}，会话「${TITLE}」`);
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	const endpoint = relay();
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	relayPort = (endpoint.address() as { port: number }).port;
	let home = "";
	app = await startApp({ port: PORT, seed: async (h) => { home = h; await seed(h); }, scaleFactor: 2 });
	const { click, type, submit, settled } = driver(app);
	const stop = await startRecording(PORT, frames);
	try {
		await pause(1200);
		await app.evaluate(`[...document.querySelectorAll("button")].find((b)=>b.textContent?.includes(${JSON.stringify(TITLE)}))?.setAttribute('data-demo-row','')`);
		await click("[data-demo-row]");
		await poll<Look>(look("①绝对路径"), (v) => Boolean(v.w), 20000);

		console.log("一、用户消息");
		await reveal("⑪用户消息里的图片语法不画");
		const user = await app.evaluate<Look>(look("⑪用户消息"));
		check("⑪ 用户消息里的 ![…](…) 不画成图", !user.img, JSON.stringify(user));

		console.log("二、模型回复里的十种写法");
		for (const c of CASES(home, join(home, "project"))) {
			await reveal(`${c.name}`);
			// 留成链接的那几种要等：读不到的先空一下，加载失败的要等 onError。
			const seen = await poll<Look>(look(c.name), (v) => (c.shows ? Boolean(v.w) : !v.img), 4000);
			check(`${c.name}：${c.shows ? "显示图片" : "留成链接"}`, c.shows ? seen.img && (seen.w ?? 0) > 0 : !seen.img && seen.text === true, JSON.stringify(seen));
			if (c.name === "①绝对路径") await shot("01_绝对路径与相对路径");
			if (c.name === "⑤波浪号主目录") await shot("02_普通链接_协议头_波浪号");
			if (c.name === "⑧用相对路径跳出项目") await shot("03_子目录文件名_项目外两种");
		}
		await shot("04_不存在_非图片");

		console.log("三、原地覆盖以后，新回复画新图");
		await QRCode.toFile(qr, "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=9Q5Q-VY4A", { width: 320, margin: 2 });
		await type("已授权，再给我一次二维码");
		await pause(500);
		await submit();
		await settled();
		const fresh = await poll<Look>(look("⑫覆盖后的新回复"), (v) => Boolean(v.w), 15000);
		await reveal("新的二维码");
		const old = await app.evaluate<Look>(look("①绝对路径"));
		check("⑫ 新回复画的是覆盖后的图（320 宽）", fresh.w === 320, JSON.stringify(fresh));
		check("⑫ 屏幕上已有的旧回复不自己刷新（仍是 256 宽）", old.w === 256, JSON.stringify(old));
		await shot("05_覆盖后的新回复");
	} catch (error) {
		await shot("失败现场").catch(() => {});
		await app.stop();
		endpoint.close();
		throw error;
	} finally {
		await stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (frames.length > 0) {
		const out = join(OUT_DIR, `${STAMP}_本地图片显示规则逐条演示_${passed}of${checks.length}.mp4`);
		await encode(frames, out);
		console.log(`视频：${out}`);
	}
	await app.stop();
	endpoint.close();
	process.exitCode = passed === checks.length ? 0 : 1;
}

await (KEEP ? keep() : main());
