/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 下一步建议：模型在回复末尾写一行，回复里不画，输入框空着时当灰字，Tab 填入；关掉设置就不再让
 * 模型写。在真窗口里走一遍，边验边录。
 *
 * 模型是假的，说 OpenAI Responses 协议。系统提示词里有那一段（或者中途作为增量补进来、没被撤掉）
 * 才在回复末尾写；回复分几次吐出来，顺带看写到一半时语法有没有露出来。
 *
 * 单测（`test/ui/followups.test.ts`）按的是合成事件；这里补它证不到的：设置开关真的传进了提示词、
 * 真按键经过命令单之后 Tab 还落在这里、回复底下没有因为拿掉那一行而多出留白。
 *
 * 用法：node --experimental-strip-types e2e/followups-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeSettings, openSession, openSettings, press, toggleSetting, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume下一步建议测试");
const PORT = 9471;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const FIELD = "main textarea";
const STEP_MS = 1000;

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

const hint = (turn: number) => `把第 ${turn} 轮的登录页 e2e 跑一遍，失败的话贴出第一条报错`;
function reply(turn: number, followups: boolean): string {
	const body = `第 ${turn} 轮：登录跳转修好了，\`redirect\` 参数原来没做编码。e2e 还没跑。`;
	return followups ? `${body}\n\n:followup[${hint(turn)}]` : body;
}

type Item = { role?: string; content?: { type: string; text?: string }[] | string };
/** 每次带工具的主请求：下一步建议那一段此刻算不算数。 */
const turns: boolean[] = [];

/** 先看开头那份系统提示词，再按顺序看中途补进来的增量：最后一次说了算。 */
function followupsActive(instructions: string, input: Item[]): boolean {
	let active = instructions.includes("\nNext step hint:");
	for (const item of input) {
		const text = typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part.text ?? "").join("");
		if (text.includes('<section-update id="followups" removed="true">')) active = false;
		else if (text.includes('<section-update id="followups">')) active = true;
	}
	return active;
}

async function sse(res: ServerResponse, text: string) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (data: Record<string, unknown>) => res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
	const id = `msg_${Math.random().toString(36).slice(2, 8)}`;
	emit({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } });
	// 切成小段慢慢吐：那一行会被切在半截上，正好看它写到一半时露不露语法。
	for (let at = 0; at < text.length; at += 9) {
		emit({ type: "response.output_text.delta", output_index: 0, delta: text.slice(at, at + 9) });
		await pause(40);
	}
	emit({ type: "response.output_item.done", output_index: 0, item: { type: "message", id } });
	emit({ type: "response.completed", response: { id: `resp_${id}`, usage: { input_tokens: 2400, output_tokens: 60, input_tokens_details: { cached_tokens: 1800 } } } });
	res.end();
}

const model = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const body = JSON.parse(raw) as { input?: Item[]; tools?: unknown[]; instructions?: string };
		// 没有工具的是标题之类的旁路请求，回一句就好。
		if (!body.tools?.length) return void sse(res, "登录跳转");
		const active = followupsActive(body.instructions ?? "", body.input ?? []);
		turns.push(active);
		setTimeout(() => void sse(res, reply(turns.length, active)), 400);
	});
});

const placeholder = () => app.evaluate<string>(`document.querySelector(${JSON.stringify(FIELD)}).placeholder`);
const value = () => app.evaluate<string>(`document.querySelector(${JSON.stringify(FIELD)}).value`);
/** 最后一条回复正文的底边，到它下面那行时间与操作的距离：拿掉那一行之后不该多出一段。 */
const gapBelowReply = () =>
	app.evaluate<number>(`(()=>{const rows=[...document.querySelectorAll("main [data-ly-quote='assistant']")];const row=rows[rows.length-1];const prose=[...row.querySelectorAll(".prose-dw")].pop();const last=prose.lastElementChild;return Math.round(prose.getBoundingClientRect().bottom-last.getBoundingClientRect().bottom);})()`);const transcript = () => app.evaluate<string>(`document.querySelector("main").innerText`);
async function waitFor(what: () => boolean | Promise<boolean>, ms = 20000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await what()) return true;
		await pause(50);
	}
	return false;
}

async function shot(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}

/** 等这一轮的回复落定，一路看着有没有露出语法。 */
async function settle(turn: number): Promise<boolean> {
	let leaked = false;
	const done = await waitFor(async () => {
		const text = await transcript();
		if (/:followup|\{prompt=/.test(text)) leaked = true;
		const at = text.indexOf(`第 ${turn} 轮：`);
		return at >= 0 && text.slice(at).includes("e2e 还没跑。") && turns.length >= turn;
	});
	await pause(600);
	return done && !leaked && !/:followup|\{prompt=/.test(await transcript());
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("model server did not start");
	app = await startApp({
		port: PORT,
		scaleFactor: 2,
		seed: async (home) => {
			await seedInteractions(home, address.port);
			const path = join(home, "settings.json");
			const settings = JSON.parse(await readFile(path, "utf8"));
			Object.assign(settings, {
				providers: [{
					id: "qa", name: "隔离测试模型（Responses）", api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test", enabled: true,
					models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }],
				}],
				defaultModelId: "qa/model",
				autoSummarizeTitle: false,
				nextPromptSuggestions: true,
				permissionMode: "full",
				thinking: "off",
				retryAttempts: 0,
				appearance: { theme: process.env.THEME ?? "light" },
			});
			await writeFile(path, JSON.stringify(settings));
		},
	});
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	try {
		await openSession(app, "qa-short");
		await until(app, `document.querySelector(${JSON.stringify(FIELD)})`);
		const resting = await placeholder();
		await pause(STEP_MS);

		console.log("一、回复里看不到建议，输入框的灰字是它");
		await type(app, FIELD, "修一下登录跳转");
		await pause(STEP_MS);
		await press(app, "Enter", 13);
		check("回复写的过程中和写完以后，都没有露出标记语法", await settle(1));
		check("提示词里有下一步建议那一段", turns[0] === true, String(turns[0]));
		check("空输入框的灰字是模型写的那句", await waitFor(async () => (await placeholder()) === hint(1), 5000), await placeholder());
		const gap = await gapBelowReply();
		check("拿掉那一行之后，回复正文底下没有多出留白", gap === 0, `${gap}px`);
		await shot("01_灰字建议");
		await pause(STEP_MS);

		console.log("二、按 Tab 填进去，发出去，下一轮换成新的一句");
		await press(app, "Tab", 9);
		check("Tab 把建议填进了输入框", (await value()) === hint(1), await value());
		await shot("02_Tab填入");
		await pause(STEP_MS);
		await press(app, "Enter", 13);
		check("第二轮落定，没有露出语法", await settle(2));
		check("灰字换成了第二轮的那句", await waitFor(async () => (await placeholder()) === hint(2), 5000), await placeholder());
		await pause(STEP_MS);

		console.log("三、有字的时候 Tab 不归它管");
		await type(app, FIELD, "换个思路");
		await press(app, "Tab", 9);
		check("框里有字时按 Tab，内容不变", (await value()) === "换个思路", await value());
		await pause(STEP_MS);

		console.log("四、设置里关掉以后，模型不再被要求写");
		await openSettings(app, "常规");
		await toggleSetting(app, "下一步建议");
		await shot("03_设置开关");
		await pause(STEP_MS);
		await closeSettings(app);
		await click(app, FIELD);
		await press(app, "Enter", 13);
		check("第三轮落定", await settle(3));
		check("关掉之后提示词里那一段撤掉了", turns[2] === false, String(turns[2]));
		check("灰字退回默认占位文字", (await placeholder()) === resting, await placeholder());
		await shot("04_关掉之后");
		await pause(STEP_MS);
	} finally {
		await stop();
	}
	await app.stop();
	const passed = checks.filter((one) => one.ok).length;
	const out = join(OUT_DIR, `${STAMP}_下一步建议_${passed}of${checks.length}.mp4`);
	await encode(frames, out, 60, 1200);
	await closeListeningServer(model);
	console.log(`\n${passed}/${checks.length} 通过 → ${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
	console.error(error);
	await app?.stop().catch(() => {});
	await closeListeningServer(model).catch(() => {});
	process.exitCode = 1;
});
