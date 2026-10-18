/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 转录里一次调用那一行怎么说：读文件、列目录说相对工作区的完整路径（只读一段的带行号，目录带 `/`），
 * 同一个后台任务连着查几次输出合成一行、说的是那个任务。
 *
 * 假模型一次一个调用：列一次目录、两次 read（一次带着历史里的说明，一次只读一段）、一条后台命令、
 * 对它连查三次输出、一条前台命令，然后回答。
 * 跑完把每一段都展开，读每一行的字；再点开合起来的那一行，看三次的输出是不是都在。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再 `node --experimental-strip-types packages/desktop/e2e/tool-rows-demo.ts [输出目录]`
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume工具行文案测试");
const PORT = 9498;
const MODEL_PORT = 9598;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const ANSWER = "三个上游的技能清单都抓到了，链接没有被替换。";
const JOB = "抓取各上游技能清单";
type Step = { tool: string; args: Record<string, unknown> } | { text: string };
/** `bash_output` 要的任务 id 只有跑起来才知道，从请求里那句「Started background job …」取。 */
const SCRIPT: ((job: string) => Step)[] = [
	() => ({ tool: "ls", args: { path: "src" } }),
	() => ({ tool: "read", args: { path: "src/normalize.ts", description: "读取第三上游响应归一化" } }),
	() => ({ tool: "read", args: { path: "src/dispatch.ts", offset: 10, limit: 20 } }),
	() => ({ tool: "bash", args: { command: "for i in 1 2 3 4; do echo 抓取第 $i 批; sleep 1; done", description: JOB, run_in_background: true } }),
	(job) => ({ tool: "bash_output", args: { id: job } }),
	(job) => ({ tool: "bash_output", args: { id: job } }),
	(job) => ({ tool: "bash_output", args: { id: job } }),
	() => ({ tool: "bash", args: { command: "echo ok", description: "确认链接未被替换" } }),
	() => ({ text: ANSWER }),
];

function sse(res: ServerResponse, payload: { type: string }): void {
	res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			// 起标题的那一次不带工具，不能吃掉剧本的一步。
			const titling = !body.includes('"tools"');
			const job = body.match(/Started background job ([\w-]+)\./)?.[1] ?? "";
			const block = titling ? { text: "工具行" } : SCRIPT[Math.min(request, SCRIPT.length - 1)](job);
			if (!titling) request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } } as never);
			if (!titling) await pause(600);
			if ("text" in block) {
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never);
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } } as never);
			} else {
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call_${request}`, name: block.tool, input: {} } } as never);
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } } as never);
			}
			sse(res, { type: "content_block_stop", index: 0 } as never);
			sse(res, { type: "message_delta", delta: { stop_reason: "tool" in block ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } } as never);
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(join(project, "src"), { recursive: true });
	await writeFile(join(project, "src", "normalize.ts"), "export const normalize = (x: unknown) => x;\n");
	await writeFile(join(project, "src", "dispatch.ts"), Array.from({ length: 40 }, (_, i) => `export const step${i} = ${i};`).join("\n"));
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 900, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [{
			id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
			models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
		}],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 1,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
		appearance: { theme: "dark" },
	}));
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

let app: RunningApp | undefined;
const model = startModel();
const frames: Frame[] = [];
let shot = 0;

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const running = app;
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	/** 每一段活那一行、以及展开后挂在竖线上的每一行，读成字。 */
	const rows = () => running.evaluate<string[]>(`[...document.querySelectorAll('main [data-ly-step] .ly-flow-row')].map((row) => row.textContent.replace(/\\s+/g, " ").trim())`);

	await d.until(`document.querySelector("main textarea")`, 60000);
	const stop = await startRecording(PORT, frames);
	await pause(800);
	await d.type("看看三个上游的技能清单");
	await pause(400);
	await d.submit();
	await d.until(`document.querySelector("main").innerText.includes(${JSON.stringify(ANSWER.slice(0, 8))})`, 60000);
	await d.settled(60000);
	await pause(1000);

	// 收着的每一段都点开：一段一段点，点开后后面的位置会变。
	for (let i = 0; i < 6; i++) {
		const opened = await running.evaluate<boolean>(`(() => {
			const row = [...document.querySelectorAll('main [data-ly-step] > .ly-flow-row')].find((node) => node.getAttribute("aria-expanded") === "false");
			if (!row) return false;
			document.querySelector("[data-qa-row]")?.removeAttribute("data-qa-row");
			row.setAttribute("data-qa-row", "");
			return true;
		})()`);
		if (!opened) break;
		await d.click("[data-qa-row]");
		await pause(700);
	}
	await pause(800);
	await capture("展开每一段_每一行怎么说");
	const said = await rows();
	console.log("每一行：", said);

	check("读文件说相对工作区的完整路径，不是模型那句「读取第三上游…」", said.some((row) => row.startsWith("读取文件 src/normalize.ts")) && said.every((row) => !row.includes("第三上游")), said);
	check("只读了一段的带上行号范围", said.some((row) => row.startsWith("读取文件 src/dispatch.ts:10-29")), said);
	check("列目录说完整路径，末尾带 /", said.some((row) => row.startsWith("列出目录 src/")), said);
	const polls = said.filter((row) => row.includes("的输出") || row === "查看输出");
	check("同一个任务连着查三次，只有一行，说的是那个任务", polls.length === 1 && polls[0].startsWith(`查看「${JOB}」的输出 3 次`), polls);
	check("没有光秃秃的「查看输出」", said.every((row) => row !== "查看输出"), said);

	// 点开合起来的那一行：三次读到的输出连起来，第一批到最后一批都在。
	const marked = await running.evaluate<boolean>(`(() => {
		const row = [...document.querySelectorAll('main [data-ly-step-rail] .ly-flow-row, main [data-ly-tool] > .ly-flow-row')].find((node) => node.textContent.includes("的输出"));
		if (!row) return false;
		row.setAttribute("data-qa-poll", "");
		return true;
	})()`);
	if (marked) {
		await d.click("[data-qa-poll]");
		await pause(1200);
		await capture("点开合起来的那一行_几次的输出连在一起");
		const output = await running.evaluate<string>(`document.querySelector("[data-qa-poll]").closest("[data-ly-tool]").innerText`);
		check("点开后第一批到第四批的输出都在，任务 id 那行不出现", output.includes("抓取第 1 批") && output.includes("抓取第 4 批") && !/\[job /.test(output), output.slice(0, 400));
	} else {
		check("点开后第一批到第四批的输出都在，任务 id 那行不出现", false, "找不到合起来的那一行");
	}
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_工具行照Claude的说法_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
}
