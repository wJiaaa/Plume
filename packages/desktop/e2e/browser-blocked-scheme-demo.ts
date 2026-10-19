/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 录一段：回复里的链接被网站 302 到 `lark://`，内置浏览器从白页变成一层说明。
 *
 * 站点是本机起的，只做飞书授权页过期后会做的那件事——把标签送去唤起客户端的地址。
 *
 *   pnpm build && node --experimental-strip-types e2e/browser-blocked-scheme-demo.ts [输出目录]
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp } from "./app.ts";
import { openSession } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume内置浏览器拦截跳转测试");
const PORT = 9634;
const TARGET = "lark://applink.feishu.cn/client/op/open";
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

const server = createServer((req, res) => {
	if (req.url?.startsWith("/oauth/v1/device/verify")) { res.writeHead(302, { location: TARGET }); res.end(); return; }
	res.writeHead(404); res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("本机站点没起来");
const link = `http://127.0.0.1:${address.port}/oauth/v1/device/verify?flow_id=demo&user_code=X9PW-HATW`;

const app = await startApp({
	port: PORT,
	seed: async (home) => {
		await seedInteractions(home);
		const path = join(home, "settings.json");
		const settings = JSON.parse(await readFile(path, "utf8"));
		settings.browser = { openLinks: "builtin" };
		settings.screenshot = { enabled: false, shortcut: "" };
		await writeFile(path, JSON.stringify(settings));
		const cwd = join(home, "project");
		const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const messages = [
			{ role: "user", content: [{ type: "text", text: "帮我重新登录一下飞书" }], timestamp: 10 },
			{ role: "assistant", content: [{ type: "text", text: `请在浏览器打开下面的链接完成授权，授权码 **X9PW-HATW**。\n\n${link}\n\n链接 10 分钟内有效。` }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 11 },
		];
		const meta = { id: "feishu-link", title: "飞书登录", projectId, projectName: "交互验证", cwd, createdAt: 3, updatedAt: 4, modelId: "qa/model", messageCount: messages.length, usage, seq: messages.length + 1 };
		seedSessions(home, [{ meta, records: [{ type: "meta", meta, ts: 3 }, ...messages.map((message) => ({ type: "message" as const, message, ts: 3 })), { type: "meta", meta, ts: 4 }] }]);
	},
});
const d = driver(app);
const frames: Frame[] = [];
await mkdir(OUT_DIR, { recursive: true });
const shot = async (name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};
try {
	await openSession(app, "feishu-link");
	const anchor = `a[href=${JSON.stringify(link)}]`;
	await d.until(`document.querySelector(${JSON.stringify(anchor)})`, 10000);
	const stop = await startRecording(PORT, frames);
	await pause(1200);
	await shot("01_回复里的授权链接");
	await d.hover(anchor);
	await pause(800);
	await d.click(anchor);
	console.log("1. 点回复里的链接");
	await d.until(`document.querySelector('[data-browser-failure="blocked"]')?.checkVisibility()`, 15000);
	await pause(1500);
	await shot("02_内置浏览器说明被拦下的跳转");
	const seen = await app.evaluate<{ text: string; button: string; bar: string[] }>(`(() => {
		const el = document.querySelector('[data-browser-failure="blocked"]');
		return { text: el.innerText, button: el.querySelector('button')?.innerText ?? "", bar: [...document.querySelectorAll('[data-browser-toolbar] input')].map((i) => i.value) };
	})()`);
	const state = await app.evaluate<{ tabs: { id: string; failure?: { kind: string; detail: string; url?: string } }[]; activeId: string }>("window.plume.browser.state()");
	const failure = state.tabs.find((tab) => tab.id === state.activeId)?.failure;
	check("遮罩标题说清楚是网页要打开应用", seen.text.includes("这个网页要打开一个应用"), seen.text);
	check("遮罩写出被拦的地址 lark://…", seen.text.includes(TARGET), seen.text);
	check("遮罩上有「在系统浏览器中打开」", seen.button.includes("在系统浏览器中打开"), seen.button);
	check("交给系统浏览器的是点开的那个网页地址", failure?.kind === "blocked" && failure.url === link, JSON.stringify(failure));
	check("地址栏仍是点开的那个链接", seen.bar.includes(link), JSON.stringify(seen.bar));
	// 不真点按钮：那会在这台机器上拉起系统浏览器。按钮发的就是上面核对过的 `external` 命令和地址。
	await d.hover('[data-browser-failure="blocked"] button');
	await pause(1500);
	await stop();
	const passed = checks.filter((entry) => entry.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_回复链接被302到客户端地址_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app.stop();
	await closeListeningServer(server);
}
