/**
 * 父会话收起、展开它下面的后续会话：收起后下一行紧贴上来、标出收了几条，重新加载还收着；
 * 打开的会话正好被收在里面时自动展开，侧边栏上找得到亮着的那一行。
 *
 * 用真鼠标点：折叠按钮只在悬停时显出来，程序 `.click()` 量不到这一层。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { COMMAND_PALETTE, click, hover, openCommandPalette, press, type, until } from "./drive.ts";
import { seedSessions, type FixtureSession } from "./session-fixture.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** 一条父会话，两条从它派生的，其中一条下面还有一条；再加一条不相干的。 */
async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	const project = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const now = Date.now();
	const make = (id: string, title: string, age: number, extra: object = {}): FixtureSession => {
		const at = now - age * 3_600_000;
		const meta = { id, title, cwd, projectId: project, projectName: "演示工程", project, createdAt: at, updatedAt: at, modelId: "test", messageCount: 2, usage, seq: 3, ...extra };
		return {
			meta,
			records: [
				{ type: "meta", meta },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: title }], timestamp: at } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的。" }], api: "anthropic-messages", provider: "test", model: "test", usage, stopReason: "stop", timestamp: at } },
			],
		} as FixtureSession;
	};
	seedSessions(home, [
		make("p", "敏感日志分文件输出优化", 40),
		make("c1", "敏感日志分文件实现", 30, { forkedFrom: { sessionId: "p" } }),
		make("c2", "敏感日志分文件实现的测试", 29, { forkedFrom: { sessionId: "p" } }),
		make("g1", "测试里补上 Windows 路径", 20, { forkedFrom: { sessionId: "c2" } }),
		make("n", "整理发布说明", 50),
	]);
	await writeFile(join(home, "settings.json"), JSON.stringify({ projects: [{ id: project, path: cwd, name: "演示工程", lastOpenedAt: now }] }));
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1000, height: 640, x: 40, y: 40 }));
}

interface Measure {
	/** 看得见、点得到的行，按位置排。 */
	visible: string[];
	/** 父会话下沿到下一条看得见的行上沿。 */
	gapBelowParent: number;
	expanded: string | null;
	count: string | null;
}

const MEASURE = `(() => {
	const rows = [...document.querySelectorAll("[data-ly-row]")].filter((row) => {
		const r = row.getBoundingClientRect();
		return !row.closest("[inert]") && r.height > 0 && document.elementFromPoint(r.left + 40, r.top + r.height / 2)?.closest("[data-ly-row]") === row;
	});
	const parent = document.querySelector('[data-ly-row="p"]');
	const next = rows[rows.indexOf(parent) + 1];
	const fold = parent.querySelector("[data-ly-row-fold]");
	return {
		visible: rows.map((row) => row.getAttribute("data-ly-row")),
		// 命令面板刚关、遮罩还在淡出时一行都点不到，这时没有「下一行」。
		gapBelowParent: next ? Math.round((next.getBoundingClientRect().top - parent.getBoundingClientRect().bottom) * 10) / 10 : NaN,
		expanded: fold?.getAttribute("aria-expanded") ?? null,
		count: parent.querySelector("[data-ly-row-folded]")?.textContent ?? null,
	};
})()`;

const FOLD = '[data-ly-row="p"] [data-ly-row-fold]';
/**
 * 收起、展开都有一段高度过渡，等它停在终点再量。`inert` 一收起就挂上，只看可见的行，过渡才刚开始
 * 就算到了；所以连父会话下面那道间距一起等，它要等高度收完才回到行距。
 */
const settled = (visible: string, gap: number) => `(() => { const m = ${MEASURE}; return m.visible.join(",") === ${JSON.stringify(visible)} && m.gapBelowParent === ${gap}; })()`;

test("父会话收起、展开后续会话，收着的状态重新加载后还在，打开收起的那条会自动展开", async () => {
	const renderer = await startDevRenderer();
	const app = await startApp({ port: 9863, seed, rendererUrl: renderer.url });
	try {
		await until(app, `document.querySelectorAll("[data-ly-row]").length >= 5`);
		const measure = () => app.evaluate<Measure>(MEASURE);

		const open = await measure();
		assert.deepEqual(open.visible, ["p", "c1", "c2", "g1", "n"]);
		assert.equal(open.expanded, "true");
		assert.equal(await app.evaluate<number>(`document.querySelectorAll("[data-ly-row-fold]").length`), 1, "只有带后续会话的那一行有折叠按钮");

		await hover(app, '[data-ly-row="p"]');
		await click(app, FOLD);
		await until(app, settled("p,n", open.gapBelowParent));
		const shut = await measure();
		assert.equal(shut.expanded, "false");
		assert.equal(shut.count, "3", "收起后标出收了几条，孙会话也算");
		assert.equal(shut.gapBelowParent, open.gapBelowParent, "收起后下一行和父会话之间的间距同行与行之间一样");

		await app.evaluate("location.reload()");
		await until(app, `document.querySelectorAll("[data-ly-row]").length >= 5`);
		await until(app, settled("p,n", open.gapBelowParent));

		await openCommandPalette(app);
		await type(app, COMMAND_PALETTE, "实现的测试");
		await press(app, "Enter", 13);
		await until(app, `document.querySelector('[data-ly-row="c2"] > button[aria-current]')`);
		await until(app, settled("p,c1,c2,g1,n", open.gapBelowParent));
		assert.equal((await measure()).expanded, "true", "打开的会话不能藏在收起的一组里");
	} finally {
		await app.stop();
		await renderer.close();
	}
});
