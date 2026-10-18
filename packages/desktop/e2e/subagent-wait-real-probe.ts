/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 子代理还没回来时，模型会不会抢先交一份回答、回来后又整份重写——真窗口、真实默认模型。
 *
 * 起因是一次真实会话：模型拿子代理 id 去调 `wait_for_session`，读到「No running session」，以为它没了，
 * 自己写了万字回答；结果送到后又被「合并成一份」逼着整份重写。修的两处都是写给模型看的话，桩模型
 * 证明不了模型读到之后怎么做，所以这里用 `~/.plume` 里的默认模型真跑：
 *
 *   A. 叫它派出子代理后用 `wait_for_session` 等：工具要说清那是子代理、结果会自己回来；模型在结果回来
 *      之前不交最终回答，回来之后只有一份回答。
 *   B. 叫它不等子代理、先凭 README 回答：子代理核对出 README 漏了一个模块，送达之后只说改变了什么，
 *      不把整份回答重写一遍。
 *
 * 每个场景各起一次应用、各录一段视频。临时 profile 用完即删。
 *
 * 用法：node --experimental-strip-types e2e/subagent-wait-real-probe.ts [输出目录]
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const REAL_HOME = join(homedir(), ".plume");
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume子代理等待测试");
const PORT = 9431;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

/** README 说三个模块，src 里实际四个：子代理核对出来的那一个，就是送达后该「只说改变了什么」的东西。 */
const MODULES: Record<string, string> = {
	"auth.ts": "// 登录与会话校验\nexport function login() {}\n",
	"billing.ts": "// 计费与账单\nexport function charge() {}\n",
	"report.ts": "// 报表导出\nexport function exportCsv() {}\n",
	"webhook.ts": "// 回调转发：把上游事件转给租户配置的地址\nexport function forward() {}\n",
};
const README = "# 演示工程\n\n三个模块：\n\n- auth：登录与会话校验\n- billing：计费与账单\n- report：报表导出\n";

const PROMPT_A =
	"派一个子代理去逐个读 src/ 下的每个文件，列出每个模块的名字和一句话职责。" +
	"派出之后，立刻用 wait_for_session 等它，to 填它的子代理 id——这是在测这个工具，无论你觉得行不行都先调一次，" +
	"然后按工具返回的话行事。拿到结果之后把模块清单告诉我。";
const PROMPT_B =
	"这个项目有哪些模块？先不要读 src，直接根据 README 给我完整回答。" +
	"同时派一个子代理去逐个读 src/ 下的文件核对 README 写得对不对——不用等它，你先回答。";

type Part = { type: string; text?: string; name?: string };
type Msg = { role: string; content?: Part[]; toolName?: string; delivery?: unknown[]; synthetic?: boolean };

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}\n      ${saw.replace(/\n/g, "\n      ")}`);
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "README.md"), README);
	for (const [name, body] of Object.entries(MODULES)) await writeFile(join(cwd, "src", name), body);
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	// 密钥原样复制，不解析、不打印；settings 只换项目列表——真实的是「跟谁说话」，不是用户的工作区。
	for (const file of ["credentials.json", "vault.key"]) {
		await copyFile(join(REAL_HOME, file), join(home, file)).catch(() => {
			throw new Error(`没找到 ~/.plume/${file}——真实模型调用需要它`);
		});
	}
	const real = JSON.parse(await readFile(join(REAL_HOME, "settings.json"), "utf8"));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({ ...real, permissionMode: "full", projects: [{ id: projectId, path: cwd, name: "演示工程", pinned: true, lastOpenedAt: Date.now() }], pinnedSessionIds: [] }),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));
}

const textOf = (message: Msg) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");

async function transcript(app: RunningApp): Promise<{ modelId: string; messages: Msg[] }> {
	return app.evaluate(`(async () => {
		const s = (await window.plume.sessions.list())[0];
		if (!s) return { modelId: "", messages: [] };
		const t = await window.plume.sessions.transcript(s.id);
		return { modelId: s.modelId, messages: t.messages };
	})()`);
}

/** 等到子代理的结果送达、送达之后那一轮也收完：界面上没有「停止」且连续 4 秒保持。 */
async function untilDeliveredAndIdle(app: RunningApp, ms = 480_000): Promise<Msg[]> {
	const end = Date.now() + ms;
	let quiet = 0;
	while (Date.now() < end) {
		const { messages } = await transcript(app);
		const at = messages.findIndex((m) => m.role === "user" && Array.isArray(m.delivery) && m.delivery.length > 0);
		const answered = at >= 0 && messages.slice(at + 1).some((m) => m.role === "assistant" && textOf(m).trim());
		const turning = await app.evaluate<boolean>(`Boolean(document.querySelector('button[aria-label="停止"]'))`);
		quiet = answered && !turning ? quiet + 1 : 0;
		if (quiet >= 8) return messages;
		await pause(500);
	}
	throw new Error("等不到子代理的结果送达并答完");
}

/** 把一次运行切成「送达之前」与「送达之后」两段，各自模型对人说了什么。 */
function split(messages: Msg[]) {
	const at = messages.findIndex((m) => m.role === "user" && Array.isArray(m.delivery) && m.delivery.length > 0);
	const before = messages.slice(0, at);
	const after = messages.slice(at + 1);
	const said = (part: Msg[]) => part.filter((m) => m.role === "assistant").map(textOf).filter((t) => t.trim());
	return { before, after, saidBefore: said(before), saidAfter: said(after) };
}

async function scenario(name: string, prompt: string, judge: (messages: Msg[], modelId: string) => void): Promise<void> {
	console.log(`\n【${name}】`);
	const frames: Frame[] = [];
	const app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);
	try {
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1500);
		await d.type(prompt);
		await pause(1000);
		await d.submit();
		const messages = await untilDeliveredAndIdle(app);
		await pause(2000);
		const { modelId } = await transcript(app);
		judge(messages, modelId);
	} finally {
		await stop();
		const passed = checks.filter((c) => c.ok).length;
		await encode(frames, join(OUT_DIR, `${STAMP}_${name}_${passed}of${checks.length}.mp4`)).catch((error: unknown) => console.log(`   （视频没合成：${String(error)}）`));
		// `startApp` 造的临时 profile 由 stop() 删掉，用户目录里不留东西。
		await app.stop();
	}
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });

	await scenario("A_拿子代理id去等", PROMPT_A, (messages, modelId) => {
		console.log(`   模型：${modelId}`);
		const waits = messages.filter((m) => m.role === "toolResult" && m.toolName === "wait_for_session").map(textOf);
		const { saidBefore, saidAfter } = split(messages);
		check("模型派出了子代理", messages.some((m) => m.role === "toolResult" && m.toolName === "task"), "");
		if (waits.length === 0) check("（模型没调 wait_for_session，A 场景没测到工具那句话）", false, "");
		else {
			check("wait_for_session 说清那是子代理、结果会自己回来", waits.every((t) => /is a sub-agent you dispatched with task/.test(t)), waits[0]!.slice(0, 300));
			check("不再出现「No running session」", waits.every((t) => !/No running session/.test(t)), "");
		}
		const early = saidBefore.join("\n");
		// 判据是职责：「回调转发」只写在 src/webhook.ts 里，送达前说出它就是没等子代理、自己交了答案。只看文件名会
		// 把「派它去读 report.ts、webhook.ts……」这种交代误判成回答（第一次跑就这样假红过一次）。
		check(
			"结果回来之前没交最终回答（没说出 webhook 的职责）",
			!/回调转发/.test(early),
			`送达前对人说的（${early.length} 字）：${early.slice(0, 300) || "（什么都没说）"}`,
		);
		const final = saidAfter.join("\n");
		check("结果回来之后给出了答案，含 webhook", /webhook/i.test(final), `送达后（${final.length} 字）：${final.slice(0, 400)}`);
	});

	if (process.env.ONLY === "A") return finish();
	await scenario("B_先答后送达", PROMPT_B, (messages) => {
		const { saidBefore, saidAfter } = split(messages);
		const first = saidBefore.join("\n");
		const second = saidAfter.join("\n");
		check("先凭 README 给了回答", /auth/i.test(first) && /billing/i.test(first), `送达前（${first.length} 字）：${first.slice(0, 400)}`);
		check("送达后指出了 README 漏掉的 webhook", /webhook/i.test(second), `送达后（${second.length} 字）：${second.slice(0, 500)}`);
		// 「只说改变了什么」：第二段不该比第一段长，也不该把三个旧模块的职责又逐条讲一遍。
		const repeated = ["登录与会话校验", "计费与账单", "报表导出"].filter((duty) => second.includes(duty));
		check(
			"送达后没有把整份回答重写一遍",
			second.length <= Math.max(first.length, 200) && repeated.length < 3,
			`第一段 ${first.length} 字，第二段 ${second.length} 字；第二段里重复了旧模块职责：${repeated.join("、") || "无"}`,
		);
	});

	finish();
}

function finish() {
	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过；视频在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
