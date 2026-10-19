/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 「编辑项目」里换主文件夹——在真窗口里悬停、点、保存，边验边录。
 *
 * 单测证明了 `updateProject` 写进设置的顺序对（`test/ui/project-entry.test.ts`）。这里补它证不到的：
 * 「设为主文件夹」平时是透明的、指针进了那一行才出来（CSS 的 `:hover`，happy-dom 里没有真指针）；
 * 点下去「主文件夹」那个标记真的挪到了这一行；保存之后写到盘上的是新的主文件夹，会话还挂在项目下。
 *
 * 用法：node --experimental-strip-types e2e/project-main-folder-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, hover, openProjectEditor, shot, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume主文件夹测试");
const PORT = 9581;
const STAMP = new Date()
	.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })
	.replace(/[: ]/g, "-")
	.slice(0, 16);
const PROJECT = "双仓项目";
const SESSION_ID = "multi-session";

let web = "";
let api = "";
let app: RunningApp;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what, saw: JSON.stringify(saw) });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

async function seed(home: string): Promise<void> {
	const root = join(home, "work");
	web = join(root, "web");
	api = join(root, "api");
	for (const path of [web, api]) {
		await mkdir(join(path, "src"), { recursive: true });
		await writeFile(join(path, "readme.md"), `# ${path}\n`);
	}
	const at = Date.now() - 60_000;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	// `project` 写上：会话只认记下的项目（ADR-0053），没有它这条会话进「最近」，项目在侧栏里就没有行。
	const meta = { id: SESSION_ID, title: "在 web 里跑的旧对话", cwd: web, project: "multi", projectId: SESSION_ID, projectName: PROJECT, createdAt: at, updatedAt: at, modelId: "", messageCount: 1, usage, seq: 2 };
	seedSessions(home, [
		{
			meta,
			records: [
				{ seq: 1, ts: at, type: "meta", meta },
				{ seq: 2, ts: at, type: "message", message: { role: "user", content: [{ type: "text", text: "你好" }], timestamp: at } },
			],
		},
	]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 820, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1, providers: [], mcpServers: [], defaultModelId: null, permissionMode: "auto",
			hooks: [], scheduledTasks: [], disabledPlugins: ["*"], alwaysAllow: [], uiLocale: "zh-CN",
			projects: [{ id: "multi", name: PROJECT, path: web, pinned: false, lastOpenedAt: 1, folders: [web, api] }],
		}),
	);
}

/** 弹窗此刻的文件夹顺序、哪一行挂着「主文件夹」、api 那一行的「设为主文件夹」画出来了多少。 */
function readDialog() {
	return app.evaluate<{ folders: string[]; main: string | null; makeMainOpacity: string | null; removable: number }>(`(() => {
		const rows = [...document.querySelectorAll("[data-ly-source-folder]")];
		const main = rows.find((row) => row.querySelector("[data-ly-main-folder]"));
		const apiRow = rows.find((row) => row.dataset.lySourceFolder === ${JSON.stringify(api)});
		const make = apiRow ? apiRow.querySelector("[data-ly-make-main]") : null;
		return {
			folders: rows.map((row) => row.dataset.lySourceFolder),
			main: main ? main.dataset.lySourceFolder : null,
			makeMainOpacity: make ? getComputedStyle(make).opacity : null,
			removable: rows.filter((row) => row.querySelector('button[aria-label^="把"]:not([data-ly-make-main])')).length,
		};
	})()`);
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	process.env.PLUME_E2E_ARTIFACTS = OUT_DIR;
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const stop = await startRecording(PORT, frames);

	try {
		console.log("【一】打开「编辑项目」：web 是主文件夹，api 是附加的");
		await until(app, `document.querySelector('[data-ly-project=${JSON.stringify(PROJECT)}]')`, 3000);
		await pause(1000);
		await openProjectEditor(app, PROJECT);
		// 指针挪到名称框上，离开文件夹行，量的才是「没悬停」的样子。
		await hover(app, "[data-ly-project-dialog] input");
		await pause(600);
		const before = await readDialog();
		check("顺序是 web、api", before.folders.join() === [web, api].join(), before.folders);
		check("「主文件夹」挂在 web 那一行", before.main === web, before.main);
		check("没悬停时 api 行的「设为主文件夹」是透明的", before.makeMainOpacity === "0", before.makeMainOpacity);
		check("两行都能移出项目", before.removable === 2, before.removable);
		await shot(app, `${STAMP}_01_改之前`);
		await pause(800);

		console.log("【二】指针进 api 那一行");
		await hover(app, `[data-ly-source-folder=${JSON.stringify(api)}]`);
		await pause(700);
		const hovering = await readDialog();
		check("悬停时「设为主文件夹」画出来了", hovering.makeMainOpacity === "1", hovering.makeMainOpacity);
		await shot(app, `${STAMP}_02_悬停出设为主文件夹`);
		await pause(800);

		console.log("【三】点「设为主文件夹」");
		await click(app, "[data-ly-make-main]");
		await pause(700);
		const swapped = await readDialog();
		check("api 排到了第一", swapped.folders.join() === [api, web].join(), swapped.folders);
		check("「主文件夹」挪到了 api 那一行", swapped.main === api, swapped.main);
		await hover(app, "[data-ly-project-dialog] input");
		await pause(500);
		await shot(app, `${STAMP}_03_换了之后`);
		await pause(800);

		console.log("【四】保存，再看盘上和侧栏");
		await click(app, "[data-ly-dialog-actions] button", "保存");
		await until(app, `!document.querySelector("[data-ly-project-dialog]")`);
		await pause(1200);
		const saved = JSON.parse(await readFile(join(app.home, "settings.json"), "utf8")) as { projects: { id: string; path: string; folders?: string[] }[] };
		const entry = saved.projects.find((project) => project.id === "multi");
		check("盘上的主文件夹是 api", entry?.path === api, entry?.path);
		check("盘上的文件夹是 api、web（web 留着）", entry?.folders?.join() === [api, web].join(), entry?.folders);
		const stillThere = await app.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-row=${JSON.stringify(SESSION_ID)}]'))`);
		check("在 web 里跑的旧对话还在侧栏里", stillThere, stillThere);
		await shot(app, `${STAMP}_04_保存之后侧栏`);

		console.log("【五】再打开一次，顺序还在");
		await openProjectEditor(app, PROJECT);
		await hover(app, "[data-ly-project-dialog] input");
		await pause(600);
		const reopened = await readDialog();
		check("重开以后主文件夹仍是 api", reopened.main === api && reopened.folders[0] === api, reopened);
		await shot(app, `${STAMP}_05_重开`);
		await pause(1200);
	} finally {
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成…`);
	}

	if (frames.length === 0) throw new Error("一帧都没采到");
	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_编辑项目换主文件夹_${passed}of${checks.length}.mp4`);
	await app.stop();
	await encode(frames, out, 60, 1200);

	console.log(`\n${passed}/${checks.length} 项通过`);
	console.log(`视频：${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exitCode = 1;
});
