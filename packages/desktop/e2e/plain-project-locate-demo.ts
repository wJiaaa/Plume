/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 不是 git 仓库的项目里，回复只写文件名——点开要找得到，而不是「读不到」。在真窗口里点，边验边录。
 *
 * 会话 dad30a02（834c1105 的侧边会话）的原样：「水墨塔防」不是 git 仓库，回复里写 `ink_splat_06.png`、
 * `bg_far.png`，点开弹「读不到 <项目根>/ink_splat_06.png」。查找原先只问 `git ls-files`，仓库外什么都
 * 列不出来；现在自己走目录，见 `electron/file-locate.ts`。
 *
 * 用法：node --experimental-strip-types e2e/plain-project-locate-demo.ts [before]
 *   带 `before` 只拍图不录像，给修复前的构建用。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const BEFORE = process.argv[2] === "before";
const OUT_DIR = join(homedir(), "Desktop", "Plume非git项目文件链接测试");
const PORT = 9439;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PHASE = BEFORE ? "修改前" : "修改后";
const SESSION = "f11ec401-0000-4000-8000-000000000002";

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

/** 真 PNG，尺寸各不相同：点开的是哪一份，看面板里那张图的宽就知道。 */
function png(path: string, size: string): void {
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=s=${size}`, "-frames:v", "1", path], { stdio: "ignore" });
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "水墨塔防");
	for (const dir of ["素材原图", "ink-defense/Assets/Art", "node_modules/pkg"]) await mkdir(join(cwd, dir), { recursive: true });
	png(join(cwd, "素材原图", "ink_splat_06.png"), "320x180");
	png(join(cwd, "ink-defense/Assets/Art", "ink_splat_06.png"), "160x90");
	png(join(cwd, "素材原图", "bg_far.png"), "640x360");
	// 依赖里的同名文件不算：要是算了，`bg_far.png` 就成了两份、要人选。
	png(join(cwd, "node_modules/pkg", "bg_far.png"), "64x36");

	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const now = Date.now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "非 git 项目里的文件名", cwd, projectId, projectName: "水墨塔防", createdAt: now, updatedAt: now, modelId: "qa/model", messageCount: 2, usage, seq: 0 };
	const reply = [
		"本轮还剩 3 张，均已在生成中：",
		"",
		"- 最后一张墨点 `ink_splat_06.png`",
		"- 远景 `bg_far.png` 重生成，修正下半部透明留白",
	].join("\n");
	seedSessions(home, [
		{
			meta,
			records: [
				{ seq: 1, ts: now, type: "meta", meta },
				{ seq: 2, ts: now, type: "message", message: { role: "user", content: [{ type: "text", text: "还有多少图片没生成的" }], timestamp: now } },
				{
					seq: 3,
					ts: now,
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: reply }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: now },
				},
				{ seq: 4, ts: now, type: "meta", meta: { ...meta, seq: 3 } },
			],
		},
	]);
	// 一个永远不会被请求的假模型：没有模型配置时窗口停在「未配置」页，回复画不出来。
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			providers: [
				{
					id: "qa",
					name: "探针",
					api: "anthropic-messages",
					baseUrl: "http://127.0.0.1:9",
					apiKey: "test",
					enabled: true,
					models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }],
				},
			],
			defaultModelId: "qa/model",
			mcpServers: [],
			hooks: [],
			permissionMode: "full",
			projects: [{ id: projectId, path: cwd, name: "水墨塔防", pinned: true, lastOpenedAt: now }],
			pinnedSessionIds: [],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820 }));
}

const text = () => app.evaluate<string>("document.body.innerText");
const IMAGE_WIDTH = (name: string) =>
	`[...document.querySelectorAll('img')].find((i)=>i.src.startsWith('ly-media:')&&i.src.includes(encodeURIComponent(${JSON.stringify(name)})))?.naturalWidth ?? 0`;

async function shot(name: string): Promise<void> {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${PHASE}_${name}.png`), Buffer.from(image.data, "base64"));
}

async function poll(expression: string, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await app.evaluate<boolean>(`Boolean(${expression})`)) return true;
		await pause(150);
	}
	return false;
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const stop = BEFORE ? async () => {} : await startRecording(PORT, frames);
	try {
		await until(app, `document.querySelector('[data-ly-row="${SESSION}"]')`);
		await pause(800);
		await openSession(app, SESSION);
		await until(app, `document.querySelectorAll('[data-ly-file-link]').length >= 2`);
		await pause(1200);
		await shot("01_回复里的两个文件名");

		console.log(`${PHASE}：点两处都有的 ink_splat_06.png`);
		await click(app, "[data-ly-file-link] a", "ink_splat_06.png");
		await pause(1000);
		if (BEFORE) {
			check("（修改前）点开弹「读不到」", await poll(`document.body.innerText.includes("读不到")`), (await text()).slice(0, 300));
			await shot("02_点开读不到");
		} else {
			const rows = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent.trim())`);
			check("弹出两份让人选，每行写它在哪个目录", JSON.stringify([...rows].sort()) === JSON.stringify(["ink-defense/Assets/Art", "素材原图"]), JSON.stringify(rows));
			check("没有弹「读不到」", !(await text()).includes("读不到"), "读不到");
			await shot("02_弹出两份让人选");

			await click(app, '[role="menuitem"]', "素材原图");
			const opened = await poll(`(${IMAGE_WIDTH("ink_splat_06.png")}) === 320`);
			await pause(1000);
			check("选「素材原图」那份：面板画出 320 宽的那张图", opened, String(await app.evaluate<number>(IMAGE_WIDTH("ink_splat_06.png"))));
			await shot("03_打开选中的那份");
		}

		console.log(`${PHASE}：点只有一份的 bg_far.png（node_modules 里那份不算）`);
		await click(app, "[data-ly-file-link] a", "bg_far.png");
		await pause(1000);
		if (BEFORE) {
			check("（修改前）点开弹「读不到」", await poll(`document.body.innerText.includes("bg_far.png") && document.body.innerText.includes("读不到")`), (await text()).slice(0, 300));
		} else {
			const unique = await poll(`(${IMAGE_WIDTH("bg_far.png")}) === 640`);
			await pause(1000);
			check(
				"只有一份的直接打开 640 宽的那张，不弹菜单",
				unique && !(await app.evaluate<boolean>(`Boolean(document.querySelector('[role="menu"]'))`)),
				String(await app.evaluate<number>(IMAGE_WIDTH("bg_far.png"))),
			);
		}
		await shot("04_唯一的那份");
	} catch (error) {
		await shot("失败现场").catch(() => {});
		throw error;
	} finally {
		await stop();
		await app.stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (!BEFORE && frames.length > 0) {
		const out = join(OUT_DIR, `${STAMP}_非git项目里只写文件名_${passed}of${checks.length}.mp4`);
		await encode(frames, out);
		console.log(`视频：${out}`);
	}
	process.exitCode = passed === checks.length ? 0 : 1;
}

await main();
