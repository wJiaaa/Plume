/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 计划审批卡上的「在新会话里执行」在真窗口里走一遍：卡片上有这一项；点了以后主会话停下、不再发请求，
 * 计划写成文件，侧栏里主会话下面多出一个会话，它的第一条消息是标题、概要、计划文件和两条规矩。
 *
 * 模型是本地起的假服务（照 `plan-mode-demo.ts`）：收到 `PLAN_ME` 交一份计划；收到交接消息回一句话。
 * 主会话在批准之后要是又发了带工具结果的请求，就是没停下——这是最要紧的那条。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/plan-handoff-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames as settle, hover, openSession, press, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume计划交接测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9872;
const SESSION = "plan-mode";
const OFF = 'main button[aria-label^="进入计划模式"]';
const FIELD = "main textarea";

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const TITLE = "登录改成 OAuth";
const SUMMARY = "加一条 OAuth 回调路由，换到 token 后复用现有的写会话；登录页换成「用 GitHub 登录」按钮。";
const PLAN = {
	plan: [`# ${TITLE}`, "", "## 概要", SUMMARY, "", "## 主要改动", "- 抽出写会话的那段，给 OAuth 复用", "- 加 OAuth 回调路由（`src/auth/oauth.ts`）", "", "## 测试", "- 跑 oauth 的测试", "", "## 假设", "- 线上和本地用同一个 OAuth 应用"].join("\n"),
};
const HANDOFF_REPLY = "收到，先读计划文件。";
const MAIN_CONTINUED = "计划已批准，开始第一步。";

/** 每次请求的最后两条消息，按到达顺序。 */
const requests: string[] = [];
/** 新会话第一次请求里那条用户消息的正文。 */
let handoffText = "";

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
			const tail = JSON.stringify(body.messages.slice(-2));
			requests.push(tail);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (tail.includes("按已批准的计划实施")) {
				const first = body.messages.find((message) => message.role === "user");
				handoffText = typeof first?.content === "string" ? first.content : (first?.content ?? []).map((block) => block.text ?? "").join("");
				reply(res, HANDOFF_REPLY);
			} else if (tail.includes('"tool_result"')) reply(res, MAIN_CONTINUED);
			else if (tail.includes("PLAN_ME")) reply(res, "", PLAN);
			else reply(res, "好的。");
		});
	});
}

function reply(res: ServerResponse, text: string, plan?: typeof PLAN) {
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	emit("message_start", { message: { id: "plan", role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: plan ? { type: "tool_use", id: "plan-1", name: "submit_plan", input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: plan ? { type: "input_json_delta", partial_json: JSON.stringify(plan) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: plan ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# plan handoff\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "计划模式", cwd, projectId, projectName: "计划交接", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "登录这块想换掉。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "可以，先说说想换成什么。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "auto",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "计划交接", pinned: true, lastOpenedAt: 1 }],
	}));
}

const server = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];

async function photo(name: string) {
	await mkdir(out, { recursive: true });
	const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(image.data, "base64"));
}

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");

	await openSession(app, SESSION);
	await until(app, `document.querySelector(${JSON.stringify(OFF)})`);
	await pause(900);

	await type(app, FIELD, "/plan PLAN_ME 把登录改成 OAuth");
	await pause(500);
	await press(app, "Enter", 13);
	await settle(app, 30);
	await until(app, "document.querySelector('[data-approval-card]')", 1200);
	await pause(1200);
	const actions = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-approval-card] [data-plan-action]')].map(e=>e.getAttribute('data-plan-action'))`);
	check("审批卡上一排：拒绝、修改、在新会话里执行、接受", actions.join("|") === "reject|revise|handoff|accept", actions);
	await hover(app, '[data-plan-action="handoff"]');
	await pause(1200);
	await photo("01_审批卡上的在新会话里执行");

	const before = requests.length;
	await click(app, '[data-plan-action="handoff"]');
	await until(app, "!document.querySelector('[data-approval-card]')", 1200);
	await until(app, "document.querySelector('[data-ly-row-nested]')", 1200);
	await pause(2000);

	check("点了以后计划模式关掉", Boolean(await app.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(OFF)}))`)), null);
	const mainAfter = requests.slice(before).filter((tail) => tail.includes('"tool_result"') && !tail.includes("按已批准的计划实施"));
	check("主会话没有接着执行：批准之后没有再带着工具结果发请求", mainAfter.length === 0, mainAfter.length);
	const mainText = await app.evaluate<string>(`document.querySelector("main").textContent ?? ""`);
	check("主会话的转录里没有「开始第一步」", !mainText.includes(MAIN_CONTINUED), null);
	check("主会话是有意停下的：不显示「上次执行被中断」，也不给继续", !mainText.includes("上次执行被中断"), null);

	const row = await app.evaluate<{ id: string; title: string }>(`(()=>{const e=document.querySelector('[data-ly-row-nested]');return {id:e.getAttribute('data-ly-row'),title:(e.textContent||'').trim()}})()`);
	check("侧栏里主会话下面多出一个会话，名字是计划标题", row.title.includes(TITLE), row);
	await photo("02_主会话停下_侧栏多出执行会话");

	const lines = handoffText.split("\n\n");
	const file = /计划文件：(\S+?)。/.exec(handoffText)?.[1] ?? "";
	check("新会话收到的第一条：标题一行", lines[0] === `按已批准的计划实施：${TITLE}`, lines[0]);
	check("第二段是计划的概要", lines[1] === SUMMARY, lines[1]);
	check("规矩里有授权范围和问谁（主会话的地址）", handoffText.includes("提交、推送") && handoffText.includes("「计划模式 [planmo]」") && handoffText.includes("ask_session"), handoffText.slice(-200));
	check("不抄计划正文", !handoffText.includes("## 主要改动"), null);
	const saved = file ? await readFile(file, "utf8").catch(() => "") : "";
	check("计划文件在会话临时目录的 plans/ 下，内容就是批准的那份", relative(app.home, file).startsWith(join("scratch", SESSION, "plans")) && saved === `${PLAN.plan}\n`, { file: relative(app.home, file), bytes: saved.length });

	await openSession(app, row.id);
	await until(app, `[...document.querySelectorAll(".ly-user-bubble")].some(e=>e.textContent.includes("计划文件"))`, 1200);
	await until(app, `document.querySelector("main").textContent.includes(${JSON.stringify(HANDOFF_REPLY)})`, 1200);
	await pause(1500);
	const bubble = await app.evaluate<string>(`[...document.querySelectorAll(".ly-user-bubble")][0]?.textContent ?? ""`);
	check("打开新会话：第一条消息就是交接说明，模型已经开始", bubble.includes(`按已批准的计划实施：${TITLE}`) && bubble.includes(file), bubble.slice(0, 80));
	await photo("03_新会话的第一条消息");
} catch (error) {
	check("验证脚本跑完", false, String(error));
	await photo("失败现场").catch(() => {});
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
	await mkdir(out, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${stamp}_在新会话里执行计划_${pass}of${checks.length}`;
	if (recorded.length) await encode(recorded, join(out, `${name}.mp4`), 30);
	console.log(`Evidence: ${out} (${recorded.length} frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
