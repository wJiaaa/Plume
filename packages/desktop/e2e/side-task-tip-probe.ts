/* oxlint-disable no-console -- probe CLI that prints what the real window measured */
/**
 * 侧边聊天派给主会话一份长计划，悬停任务行时那个提示气泡要装在窗口里。
 *
 * 起因：派出去的经常是一整份几十行的计划，任务行的提示把它整段放进去，气泡一路长出窗口底部，
 * 拼在最后的状态行（「主会话执行中」）被挤到看不见的地方。
 *
 * 走法：假的 Anthropic 端点，侧聊一问就调 `dispatch_task` 交出 `PLAN`；主会话收到这件任务时不答，
 * 一直挂着，任务停在「执行中」。悬停那一行，量气泡的上下沿、行数，看状态行在不在。
 *
 * 用法：node --experimental-strip-types e2e/side-task-tip-probe.ts [输出目录] [文件名标签]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, hover, openPane, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { pause } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume侧聊任务提示测试");
const TAG = process.argv[3] ?? "当前";
const PORT = 9437;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SIDE = '[data-dock-pane="chat"]';
const MARK = "LONGTASK_MARK";
const PLAN = [
	`${MARK} 请只审核下面这份补充后的计划，不要实施、不要修改代码。`,
	"",
	"# 敏感日志分文件输出计划（待主会话审核）",
	...Array.from({ length: 12 }, (_, i) => [
		"",
		`## 第 ${i} 步`,
		`第 ${i} 步的说明：沿用各模块现有配置，格式、路径、轮转及异步参数保持一致，开关默认关闭，修改后需重启生效。`,
	]).flat(),
].join("\n");

const holding: ServerResponse[] = [];
function anthropic(res: ServerResponse, text: string, tool?: { name: string; input: Record<string, unknown> }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "tip", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: "call-dispatch", name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}
const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (data) => { raw += data; });
	req.on("end", () => {
		const body = JSON.parse(raw) as { tools?: { name: string }[]; messages?: { content: unknown }[] };
		const side = body.tools?.some((tool) => tool.name === "read_main_chat") ?? false;
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (side) {
			const last = JSON.stringify(body.messages?.at(-1)?.content ?? "");
			if (last.includes("tool_result")) return anthropic(res, "已交给主会话。");
			return anthropic(res, "", { name: "dispatch_task", input: { instruction: PLAN } });
		}
		// 主会话接到这件任务就挂着不答：任务停在「执行中」，那一行才一直在。
		if (raw.includes(MARK)) {
			holding.push(res);
			return;
		}
		return anthropic(res, "主会话回答。");
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

await mkdir(OUT_DIR, { recursive: true });
const app: RunningApp = await startApp({ port: PORT, seed: (home) => seedInteractions(home, address.port) });
async function snap(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${TAG}_${name}.png`), Buffer.from(image.data, "base64"));
}

try {
	console.log("1. 开侧边聊天，让它把长计划派给主会话");
	await openSession(app, "qa-short");
	await openPane(app, "侧边聊天");
	await until(app, `document.querySelector('${SIDE} textarea')`, 900);
	await click(app, `${SIDE} textarea`);
	await app.send("Input.insertText", { text: "把这份计划交给主会话审核" });
	await frames(app, 2);
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
	const row = `${SIDE} [data-ly-tip*="${MARK}"]`;
	await until(app, `document.querySelector(${JSON.stringify(row)})`, 1800);
	await pause(800);

	console.log("2. 悬停任务行，量提示气泡");
	await hover(app, row);
	await until(app, `(()=>{const t=document.querySelector('.ly-tooltip');return t&&!t.hidden&&t.innerText.includes('${MARK}');})()`, 600);
	await pause(400);
	const tip = await app.evaluate<{ top: number; bottom: number; height: number; window: number; text: string; lines: number }>(`(()=>{
		const t=document.querySelector('.ly-tooltip'),r=t.getBoundingClientRect(),lh=parseFloat(getComputedStyle(t).lineHeight);
		return {top:r.top,bottom:r.bottom,height:r.height,window:innerHeight,text:t.innerText,lines:Math.round((r.height-8)/lh)};
	})()`);
	console.log(`   气泡 top=${Math.round(tip.top)} bottom=${Math.round(tip.bottom)} 高=${Math.round(tip.height)} 窗口高=${tip.window} 约 ${tip.lines} 行`);
	check("气泡整个在窗口里", tip.top >= 0 && tip.bottom <= tip.window, { top: tip.top, bottom: tip.bottom, window: tip.window });
	check("气泡不超过十行", tip.lines <= 10, tip.lines);
	// 状态行拼在最后：气泡的下沿在窗口里，它才是看得见的。
	check("状态行「主会话执行中」看得见", tip.text.trimEnd().endsWith("主会话执行中") && tip.bottom <= tip.window, { tail: tip.text.slice(-20), bottom: tip.bottom });
	check("截掉的部分有省略号", tip.text.includes("…"), tip.text.slice(0, 120));
	await snap("01_悬停任务行");
} catch (error) {
	console.error(error);
	check("脚本跑完", false, String(error));
	await snap("失败时的样子").catch(() => {});
} finally {
	for (const res of holding) res.destroy();
	await app.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((one) => one.ok).length;
console.log(`\n${passed}/${checks.length} 通过。截图在 ${OUT_DIR}`);
process.exit(passed === checks.length ? 0 : 1);
