/* oxlint-disable no-console -- demo CLI that prints what the real window did */
/**
 * 一条回复里先播报、再给最终答复：最终答复把播报重说一遍时，转录里每句话只出现一次。
 *
 * 种两个内容相同的会话：一个文本块带 `phase`（新录下的样子），一个不带（改动前、以及旧会话）。
 * 不带的那个照旧整段重复——这一份同时就是改动前的截图。
 *
 * 用法：node --experimental-strip-types e2e/reply-phase-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume重复回答测试");
const PORT = 9437;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const WITH_PHASE = randomUUID();
const WITHOUT_PHASE = randomUUID();

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: "relay/gpt-6.1-sol", providerId: "relay", modelId: "gpt-6.1-sol", name: "gpt-6.1-sol", contextWindow: 200000, maxOutputTokens: 8192, supportsImages: false, supportsTools: true, supportsThinking: false };

const LEAD = "我先读一下 package.json，确认启动脚本。";
const GOT = "已收到「应用入口与进程边界」的核对结果，确认 API Worker 不执行 Agent Run。";
const WAIT = "我会等剩余的数据流核对结果到达后，再把两部分合并成完整的架构梳理。";
const CLOSE = "未修改代码、未启动服务或运行测试。";

function messages(phased: boolean, t: number) {
	const text = (body: string, phase: "commentary" | "final_answer") => ({ type: "text", text: body, ...(phased ? { phase } : {}) });
	const assistant = (content: unknown[], stopReason: string, timestamp: number) => ({ role: "assistant", content, api: "openai-responses", provider: "relay", model: "gpt-6.1-sol", usage, stopReason, timestamp });
	return [
		{ role: "user", content: [{ type: "text", text: "梳理一下这个仓库的架构。" }], timestamp: t },
		// 调工具前的那句播报后面跟的是工作，不是答复：它必须照常画出来。
		assistant([text(LEAD, "commentary"), { type: "toolCall", id: "c1", name: "read", arguments: { path: "package.json" } }], "toolUse", t + 1000),
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "{}" }], isError: false, timestamp: t + 2000 },
		// 会话 40152d28 里那一条的形状：两段播报，收尾的答复把它们原样再写一遍。
		assistant([text(GOT, "commentary"), text(WAIT, "commentary"), text(`${GOT}\n\n${WAIT}\n\n${CLOSE}`, "final_answer")], "stop", t + 3000),
	];
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const t = Date.now() - 10 * 60_000;
	const session = (id: string, title: string, phased: boolean, at: number) => {
		const list = messages(phased, at);
		const meta = { id, title, projectId, projectName: "重复回答", cwd, createdAt: at, updatedAt: at + 3000, modelId: model.id, messageCount: list.length, usage, seq: list.length + 1 };
		return {
			meta,
			records: [
				{ type: "meta", meta, seq: 0, ts: at },
				...list.map((message, i) => ({ type: "message", message, seq: i + 1, ts: message.timestamp })),
				{ type: "meta", meta, seq: meta.seq, ts: at + 3000 },
			],
		};
	};
	seedSessions(home, [session(WITHOUT_PHASE, "没有 phase（改动前）", false, t), session(WITH_PHASE, "带 phase（改动后）", true, t + 60_000)] as never);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 860 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			providers: [{ id: "relay", name: "Relay", api: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKey: "test", enabled: true, models: [model] }],
			defaultModelId: model.id,
			language: "zh-CN",
			mcpServers: [],
			hooks: [],
			projects: [{ id: projectId, path: cwd, name: "重复回答", pinned: true, lastOpenedAt: t }],
		}),
	);
}

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

async function screenshot(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}

/** 转录里一句话出现了几次：数可见的正文，不读组件状态。 */
const times = (sentence: string) =>
	app.evaluate<number>(`document.querySelector("[data-ly-transcript-rows]").innerText.split(${JSON.stringify(sentence)}).length - 1`);

async function open(id: string) {
	await openSession(app, id);
	await until(app, `document.querySelector("[data-ly-transcript-rows]")?.innerText.includes(${JSON.stringify(CLOSE)})`);
	await pause(1200);
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	try {
		console.log("没有 phase 的会话（改动前、旧会话）：");
		await open(WITHOUT_PHASE);
		check("「已收到…」照旧出现两次——没有 phase 就不猜", (await times(GOT)) === 2, await times(GOT));
		await screenshot("01_改动前_没有phase_整段重复");

		console.log("带 phase 的会话：");
		await open(WITH_PHASE);
		check("「已收到…」只出现一次", (await times(GOT)) === 1, await times(GOT));
		check("「我会等…」只出现一次", (await times(WAIT)) === 1, await times(WAIT));
		check("最终答复的收尾一句在", (await times(CLOSE)) === 1, await times(CLOSE));
		check("调工具前的播报照常画出来", (await times(LEAD)) === 1, await times(LEAD));
		await screenshot("02_改动后_带phase_每句一次");
		await pause(800);
	} finally {
		await stop();
		await app.stop();
	}
	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_播报不再被最终答复重复_${passed}of${checks.length}.mp4`);
	await encode(frames, out, 60, 1200);
	console.log(`\n${passed}/${checks.length} 通过，录像：${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exit(1);
});
