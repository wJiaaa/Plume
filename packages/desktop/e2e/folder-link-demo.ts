/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 回复里链着一个文件夹，点下去不再说「读不到」——在真窗口里点，边验边录。
 *
 * 834c1105 那一轮的原样：模型写 `[素材原图目录](素材原图/)`，点开弹「读不到 …/素材原图」，而那个文件夹
 * 就在那里。现在文件夹交给系统打开（访达），不开文件标签，不弹提示，见 `openFilePane`。
 *
 * 点文件夹会真的开一个访达窗口，那是这次要的行为；它不在录像里，录的只有这个 BrowserWindow。
 *
 * 用法：node --experimental-strip-types e2e/folder-link-demo.ts [before]
 *   带 `before` 只拍图，给修复前的构建用。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const BEFORE = process.argv[2] === "before";
const OUT_DIR = join(homedir(), "Desktop", "Plume文件夹链接测试");
const PORT = 9433;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PHASE = BEFORE ? "修改前" : "修改后";
const TITLE = "文件夹链接";

let app: RunningApp;

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(join(project, "素材原图"), { recursive: true });
	await writeFile(join(project, "README.md"), "# 演示工程\n\nREADME-OK\n");
	await writeFile(join(project, "素材原图", "说明.txt"), "原图都在这里");

	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			uiLocale: "zh-CN",
			permissionMode: "full",
			projectMemory: false,
			autoSummarizeTitle: false,
			mcpServers: [],
			hooks: [],
			appearance: { reduceMotion: "on" },
			projects: [{ id: projectId, path: project, name: "演示工程", pinned: true, lastOpenedAt: Date.now() }],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820 }));

	const reply = [
		"P0 共 22 张 PNG 原图已按清单命名保存到[素材原图目录](素材原图/)，未做裁切。",
		"",
		"不带斜杠的写法：[原图文件夹](素材原图)。说明见 [README.md](README.md)。",
	].join("\n");
	const meta = {
		id: "folder-links",
		title: TITLE,
		cwd: project,
		projectId,
		projectName: "演示工程",
		createdAt: 1,
		updatedAt: Date.now(),
		modelId: "",
		messageCount: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		seq: 3,
	};
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: 1, type: "meta", meta },
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: "原图存哪了" }], timestamp: 2 } },
			{ seq: 3, ts: 3, type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: 3 } },
		],
	} as never]);
}

async function shot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT_DIR, `${STAMP}_${PHASE}_${name}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	console.log(`   · ${file}`);
}

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

const unreadable = () => app.evaluate<boolean>(`/读不到/.test(document.body.innerText)`);
const iconOf = (label: string) =>
	app.evaluate<string>(`[...document.querySelectorAll('[data-ly-file-link] a')].find((a)=>a.textContent.includes(${JSON.stringify(label)}))?.querySelector('svg')?.getAttribute('class') ?? ''`);

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const { click, until } = driver(app);
	const stop = BEFORE ? async () => {} : await startRecording(PORT, frames);
	try {
		await pause(1200);
		await app.evaluate(`[...document.querySelectorAll("button")].find((b)=>b.textContent?.includes(${JSON.stringify(TITLE)}))?.setAttribute('data-demo-row','')`);
		await click("[data-demo-row]");
		await until(`document.querySelectorAll('[data-ly-file-link]').length >= 3`, 20000);
		await pause(1200);

		if (!BEFORE) {
			check("带斜杠的文件夹链接是文件夹图标", /lucide-folder\b/.test(await iconOf("素材原图目录")), await iconOf("素材原图目录"));
			check("README.md 仍是文件图标", !/lucide-folder\b/.test(await iconOf("README.md")), await iconOf("README.md"));
		}
		await shot("01_回复里的链接");

		console.log("① 点「素材原图目录」");
		await clickLink("素材原图目录");
		await pause(1500);
		check("点带斜杠的文件夹链接：不弹「读不到」", !(await unreadable()), "读不到");
		await shot("02_点文件夹链接之后");

		console.log("② 点不带斜杠的「原图文件夹」");
		await clickLink("原图文件夹");
		await pause(1500);
		check("点不带斜杠的文件夹链接：不弹「读不到」", !(await unreadable()), "读不到");

		console.log("③ 点 README.md，文件照旧开在面板里");
		await clickLink("README.md");
		await until(`document.body.innerText.includes('README-OK')`, 6000).catch(() => {});
		await pause(1200);
		check("文件链接照旧开出文件面板", await app.evaluate<boolean>(`document.body.innerText.includes('README-OK')`));
		await shot("03_文件照旧打开");
	} catch (error) {
		await shot("失败现场").catch(() => {});
		await app.stop();
		throw error;
	} finally {
		await stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (!BEFORE && frames.length > 0) {
		const out = join(OUT_DIR, `${STAMP}_回复里的文件夹链接_${passed}of${checks.length}.mp4`);
		await encode(frames, out);
		console.log(`视频：${out}`);
	}
	await app.stop();
	process.exitCode = passed === checks.length ? 0 : 1;
}

await main();
