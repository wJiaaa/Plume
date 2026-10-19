/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 跑完的一段命令，折叠起来那一行说的是每条命令自己的说明，而不是「执行命令 5 个」。
 *
 * 假模型先说一句、发三条命令，再不说话发两条：五条并成一行。命令是真的，跑在隔离的临时目录里。
 *
 * 用法：`node --experimental-strip-types packages/desktop/e2e/step-names-demo.ts [输出目录] [标签]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, expandLastTurn, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume进度说明测试");
const label = process.argv[3] ?? "改后";
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9817;
const PROMPT = "STEP_NAMES 看一下这个项目";
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

type Command = { command: string; description: string };
const FIRST: Command[] = [
	{ command: "ls -la", description: "列出项目根目录" },
	{ command: "cat README.md", description: "读项目说明" },
	{ command: "wc -l README.md", description: "数一下说明有几行" },
];
const SECOND: Command[] = [
	{ command: "pwd", description: "确认工作目录" },
	{ command: "echo ok", description: "确认命令能跑" },
];

function reply(res: ServerResponse, messages: unknown[]) {
	const text = JSON.stringify(messages);
	const results = text.slice(text.lastIndexOf("STEP_NAMES")).split('"tool_result"').length - 1;
	const [say, commands] = results === 0 ? ["先看一下项目里有什么。", FIRST] : results === FIRST.length ? ["", SECOND] : ["看完了：一个只有说明文件的空项目。", []];
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	let index = 0;
	if (say) {
		emit("content_block_start", { index, content_block: { type: "text", text: "" } });
		emit("content_block_delta", { index, delta: { type: "text_delta", text: say } });
		emit("content_block_stop", { index: index++ });
	}
	for (const [n, command] of commands.entries()) {
		emit("content_block_start", { index, content_block: { type: "tool_use", id: `call-${results}-${n}`, name: "bash", input: {} } });
		emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(command) } });
		emit("content_block_stop", { index: index++ });
	}
	emit("message_delta", { delta: { stop_reason: commands.length > 0 ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# step names\n\n只有一个说明文件。\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: "step-names", title: "折叠行说什么", cwd, projectId, projectName: "折叠行说什么", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 0, usage, seq: 1 };
	seedSessions(home, [{ meta, records: [{ type: "meta", meta, seq: 0, ts: 1 }] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 760, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "折叠行说什么", pinned: true, lastOpenedAt: 1 }],
	}));
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body: unknown = JSON.parse(raw);
		assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
		reply(res, body.messages);
	});
});
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const frames: Frame[] = [];

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	const running = app;
	const shot = async (name: string) => {
		const picture = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${label}_${name}.png`), Buffer.from(picture.data, "base64"));
	};

	await until(running, `document.body.innerText.includes("折叠行说什么")`, 300);
	// 没有消息的会话不进侧栏，点项目那一行，在项目里开一段对话。
	await click(running, "a,button,[role=button]", "折叠行说什么");
	await until(running, `document.querySelector("main textarea")`, 300);
	await running.evaluate(`(()=>{const field=document.querySelector("main textarea");field.focus();const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;setter.call(field,${JSON.stringify(PROMPT)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(400);
	await running.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await running.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

	await until(running, `document.querySelector("main")?.innerText.includes("一个只有说明文件的空项目")`, 300);
	// 一轮跑完，过程默认收起：点开它，露出那一段命令的折叠行。
	await pause(1200);
	const stepRow = "main [data-ly-step] > .ly-flow-row";
	await expandLastTurn(running, `document.querySelector(${JSON.stringify(stepRow)})`);
	await pause(1000);
	const head = await running.evaluate<string>(`document.querySelector(${JSON.stringify(stepRow)})?.textContent?.trim() ?? ""`);
	await shot("01_跑完后的折叠行");
	if (label === "改前") check("改前：折叠行只报数", head.startsWith("执行命令 5 个"), head);
	else check("改后：折叠行说前两条命令的说明，再报一共几项", head.startsWith("列出项目根目录、读项目说明 等 5 项"), head);

	await expandLastTurn(running, `document.querySelectorAll("main [data-ly-step-rail] [data-ly-tool]").length >= 5`);
	await pause(1200);
	const lines = await running.evaluate<string[]>(`[...document.querySelectorAll("main [data-ly-step-rail] [data-ly-tool] > .ly-flow-row")].map((row)=>row.textContent.trim())`);
	await shot("02_点开后每条命令一行");
	check("点开后五条命令各一行，说的是各自的说明", lines.length === 5 && lines[0].startsWith("列出项目根目录") && lines[4].startsWith("确认命令能跑"), lines);
	await pause(800);
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
if (frames.length > 0) await encode(frames, join(out, `${stamp}_${label}_折叠行说什么_${passed}of${checks.length}.mp4`));
console.log(`${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exitCode = 1;
