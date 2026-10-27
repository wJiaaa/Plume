/**
 * 划词菜单横向对着选中的那几个字，不对着它们所在的那一栏。
 *
 * 跨三条列表项划选时，中间那条 `<li>` 整个落进选区，`Range.getBoundingClientRect()` 把它整栏宽
 * 的边框盒并了进来，菜单被推到栏的右半边、悬在上一段的末尾。只选两条时中间没有整条的项，看不出来。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { clickAt, dragSelect, frames, openSession, shot, textSpan, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const ID = "quote-menu-anchor";
const REPLY = "相比继续增加内置模板，我更建议：\n\n- 文档菜单增加“创建副本”。\n- 当前文档可以“保存为模板”。\n- 新建时可以选自己的模板，并能重命名和删除模板。";
const WITHIN = '[data-ly-chat-surface="conversation"] [data-ly-quote]';
const MENU = '[data-ly-popover][role="menu"]';

let app: RunningApp;
let renderer: Awaited<ReturnType<typeof startDevRenderer>>;

before(async () => {
	renderer = await startDevRenderer();
	app = await startApp({
		port: 9681,
		rendererUrl: renderer.url,
		async seed(home) {
			const cwd = join(home, "project");
			await mkdir(cwd, { recursive: true });
			const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
			const at = Date.now() - 600_000;
			const message = (seq: number, role: string, text: string) => ({ seq, ts: at + seq * 1000, type: "message", message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 } });
			const meta = { id: ID, title: "划词菜单", cwd, projectId, projectName: "演示", createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, seq: 0 };
			seedSessions(home, [{ meta, records: [{ seq: 1, ts: at, type: "meta", meta }, message(2, "user", "问题"), message(3, "assistant", REPLY)] as never }]);
			await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, providers: [], mcpServers: [], projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: Date.now() }], defaultModelId: null, permissionMode: "auto", hooks: [], scheduledTasks: [], disabledPlugins: [] }));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 860, x: 0, y: 0 }));
		},
	});
	await frames(app, 60);
	await openSession(app, ID);
	await frames(app, 30);
});

after(async () => {
	await app?.stop();
	await renderer?.close();
});

/** 从 `from` 拖到 `to`，量菜单的横中线和选中的字本身的横中线——后者逐段量字的行框，不经被测的代码。 */
async function centers(from: string, to: string): Promise<{ menu: number; text: number }> {
	await clickAt(app, { x: 5, y: 5 });
	await until(app, `!document.querySelector(${JSON.stringify(MENU)})`);
	const a = await textSpan(app, WITHIN, from);
	const b = await textSpan(app, WITHIN, to);
	await dragSelect(app, a.start, b.end);
	await until(app, `document.querySelector(${JSON.stringify(MENU)})`);
	// 菜单从挂点放大出来，等动画走完再量。
	await frames(app, 30);
	return app.evaluate(`(()=>{
		const menu=document.querySelector(${JSON.stringify(MENU)}).getBoundingClientRect();
		const sel=window.getSelection().getRangeAt(0);
		const walker=document.createTreeWalker(sel.commonAncestorContainer,NodeFilter.SHOW_TEXT);
		const xs=[];
		for(let n;(n=walker.nextNode());){
			if(!sel.intersectsNode(n))continue;
			const piece=document.createRange();piece.selectNodeContents(n);
			if(n===sel.startContainer)piece.setStart(n,sel.startOffset);
			if(n===sel.endContainer)piece.setEnd(n,sel.endOffset);
			for(const r of piece.getClientRects())if(r.width>0)xs.push(r.left,r.right);
		}
		return {menu:Math.round(menu.left+menu.width/2),text:Math.round((Math.min(...xs)+Math.max(...xs))/2)};
	})()`);
}

test("跨三条列表项划选：菜单对着选中的字，不被中间那条整栏宽的项推到右边", async () => {
	const { menu, text } = await centers("文档菜单", "删除模板。");
	await shot(app, "quote-menu-anchor-three-items");
	assert.ok(Math.abs(menu - text) <= 2, `菜单中线 ${menu}，选中的字中线 ${text}`);
});

test("跨两条列表项划选：照旧对着选中的字", async () => {
	const { menu, text } = await centers("文档菜单", "保存为模板”。");
	assert.ok(Math.abs(menu - text) <= 2, `菜单中线 ${menu}，选中的字中线 ${text}`);
});
