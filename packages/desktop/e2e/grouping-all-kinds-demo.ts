/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 探索、终端、改文件、浏览器挨在一起合成一行，其余只和同一种合；后台命令结果挂进它回来时的那一段，挨着自己一行的并成一行
 * ——拿一段真实会话在真窗口里看，边验边录。
 *
 * 会话从本机 `~/.plume/sessions/sessions.db` 复制出来（只留这一条），放进一次性的 profile，结束时删掉。
 * 那一段是边改边在页面上验：读文件、加载 skill、切标签页、建文件、勾清单、跑后台命令、打开和操作网页、
 * 改文件，中间回来四次后台命令的结果，其中一次失败。
 *
 * 用法：node --experimental-strip-types e2e/grouping-all-kinds-demo.ts [before|after] [会话 id] [输出目录]
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, openSession } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { sessionsDbPath } from "./session-fixture.ts";

const LABEL = process.argv[2] ?? "after";
const SESSION = process.argv[3] ?? "661213c4-a71b-461f-8921-6ebd3a87df79";
const OUT_DIR = process.argv[4] ?? join(homedir(), "Desktop", "Plume过程分组测试");
const PORT = 9498;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

/** 这一段的起止：两句话之间那几十次调用。 */
const FROM = "前后端已接通，类型检查通过";
const TO = "接口测试已通过，确认返回全部冲突任务";

async function seed(home: string): Promise<void> {
	const db = sessionsDbPath(home);
	await mkdir(join(home, "sessions"), { recursive: true });
	// `.backup` 只读源库，拿到的是一致的快照（含 WAL 里还没落盘的）。
	execFileSync("sqlite3", ["-readonly", join(homedir(), ".plume", "sessions", "sessions.db"), `.backup '${db}'`]);
	const keep = SESSION.replace(/'/g, "");
	const tables = execFileSync("sqlite3", [db, "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%session_id%'"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	execFileSync("sqlite3", [db, [...tables.map((t) => `DELETE FROM ${t} WHERE session_id != '${keep}';`), `DELETE FROM sessions WHERE id != '${keep}';`, "VACUUM;"].join(" ")]);
	const cwd = execFileSync("sqlite3", [db, `SELECT json_extract(meta, '$.cwd') FROM sessions WHERE id = '${keep}'`], { encoding: "utf8" }).trim();
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [],
		mcpServers: [],
		projects: [{ id: cwd, name: cwd.split("/").at(-1), path: cwd, pinned: true, lastOpenedAt: 1 }],
		showThinking: true,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

/** 两句话之间画在最外层的每一行：一段活（`[data-ly-step]`）或者一行后台命令的结果（`[data-delivery-kind="job"]`）。 */
const between = `(() => {
	const textAt = (needle) => {
		const walk = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT);
		for (let node = walk.nextNode(); node; node = walk.nextNode()) if (node.textContent.includes(needle)) return node.parentElement;
		return null;
	};
	const a = textAt(${JSON.stringify(FROM)}), b = textAt(${JSON.stringify(TO)});
	if (!a || !b) return null;
	return [...document.querySelectorAll('main [data-ly-step], main [data-delivery-kind="job"]')]
		.filter((row) => a.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING && row.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
		.filter((row) => !row.parentElement.closest("[data-ly-step]"))
		.map((row, i, all) => (i === 0 && row.setAttribute("data-probe-first", ""), i === all.length - 1 && row.setAttribute("data-probe-last", ""), row))
		.map((row) => ({
			kind: row.getAttribute("data-ly-step") ?? "job",
			text: (row.querySelector(".ly-flow-row") ?? row).textContent.replace(/\\s+/g, " ").trim(),
			failed: Boolean(row.querySelector(":scope > .ly-flow-row .text-danger\\\\/85, :scope > div > .ly-flow-row .text-danger\\\\/85")),
		}));
})()`;

let app: RunningApp | undefined;
const frames: Frame[] = [];
let shot = 0;

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	const scrollTo = (needle: string) => app!.evaluate(`(() => {
		const walk = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT);
		for (let node = walk.nextNode(); node; node = walk.nextNode()) if (node.textContent.includes(${JSON.stringify(needle)})) { node.parentElement.scrollIntoView({ block: "start" }); return true; }
		return false;
	})()`);

	await d.until(`document.querySelector('[data-ly-row="${SESSION}"]')`, 60000);
	const stop = await startRecording(PORT, frames);
	await pause(800);
	await openSession(app, SESSION);
	await d.until(`document.querySelector("main")?.textContent.includes(${JSON.stringify(TO)})`, 20000);
	await pause(1000);

	await scrollTo(FROM);
	await pause(1200);
	const rows = await app.evaluate<{ kind: string; text: string; failed: boolean }[] | null>(between);
	console.log(`「${FROM}」到「${TO}」之间 ${rows?.length} 行：`);
	for (const row of rows ?? []) console.log(`   [${row.kind}] ${row.failed ? "⊗ " : ""}${row.text}`);
	await capture("两句话之间那一段");

	if (LABEL === "after") {
		const kinds = rows?.map((row) => row.kind) ?? [];
		const merges = new Set(["explore", "terminal", "files", "browser"]);
		check("读、跑、改、操作网页挨着的已合成一段：没有相邻的两行都是这四类", kinds.every((kind, i) => i === 0 || !(merges.has(kind) && merges.has(kinds[i - 1]))), kinds);
		check("没有相邻的两行是同一种", kinds.every((kind, i) => i === 0 || kind !== kinds[i - 1]), kinds);
		check("Skill、清单各自一行", kinds.includes("skill") && kinds.includes("todo_write"), kinds);
		const jobs = rows?.filter((row) => row.kind === "job") ?? [];
		check("挨着的两条后台命令结果并成一行", jobs.length === 1 && /2 个后台命令/.test(jobs[0].text), jobs);
		const last = rows?.at(-1);
		check("在那一段中间回来的失败结果给这一段挂上失败记号", last?.failed === true, last);

		// 点开最后那一段：挂在里面的两条后台命令结果排在各自回来的位置。
		await app.evaluate(`document.querySelector("main [data-probe-last]")?.scrollIntoView({ block: "center" })`);
		await pause(800);
		await click(app, "main [data-probe-last] .ly-flow-row");
		await pause(1400);
		const rail = await app.evaluate<string[] | null>(`(() => {
			const rail = [...document.querySelectorAll("main [data-probe-last] [data-ly-step-rail]")].find((el) => el.getBoundingClientRect().height > 0);
			return rail ? [...rail.querySelectorAll('[data-delivery-kind="job"]')].map((row) => row.textContent.replace(/\\s+/g, " ").trim()) : null;
		})()`);
		console.log("点开后：", rail);
		const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_02_点开最后那一段.png`), Buffer.from(data, "base64"));
		check("点开后两条后台命令结果都在竖线上", rail?.length === 2, rail);
		check("失败的那一次照旧说退出码", rail?.some((job) => /失败/.test(job) && /退出码 1/.test(job)) === true, rail);
		await pause(1000);
	}
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	const video = join(OUT_DIR, `${STAMP}_${LABEL}_过程分组_${passed}of${checks.length}.mp4`);
	await encode(frames, video);
	console.log(`\n${passed}/${checks.length} 通过，视频：${video}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
}
