/**
 * 插话（「现在就发」）和编辑重发停的是这一轮，不是这场对话：排在后面的话、别的会话等着回答的请求、
 * 还没被循环取走的插话、后台命令的结束报告都留着。只有停止按钮把它们收回。
 *
 * 从前两条路都走停止按钮那一套清空：人点一下「现在就发」，排在后面的那几句就没了，等回答的发件方被
 * 告知信丢了，后台构建跑完也再没人告诉模型。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { backgroundJobs } from "../src/tools/background-jobs.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type PeerLetter, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model", providerId: "fake", modelId: "m", name: "Fake", contextWindow: 100_000,
	maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true,
};
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full" };

const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
	({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fake", model: "m", usage: emptyUsage(), stopReason, timestamp: Date.now() });
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const said = (messages: Message[]) => messages.map((message) => `${message.role}:${message.role === "user" && message.peer ? "<信>" : textOf(message)}`);
const request = (text: string): PeerLetter => ({ id: "r1", request: true, sessionId: "a1b2c3d4", from: "发版 [a1b2c3]", text, cwd: "/work", chain: ["a1b2c3d4"] });

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** 第一次请求（「写文档」）一直写不完，直到被停下；别的都答「好」。 */
async function harness() {
	const root = await mkdtemp(join(tmpdir(), "ly-interrupt-inbox-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	const saved = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	Object.assign(process.env, { PLUME_HOME: home, HOME: home, USERPROFILE: home });
	const requests: LlmContext[] = [];
	const events: AgentEvent[] = [];
	let hanging = false;
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: (event) => void events.push(event),
		streamFn: async (context, options) => {
			if (context.tools.length === 0) return assistant("{}");
			requests.push({ ...context, messages: [...context.messages] });
			if (requests.length === 1) {
				hanging = true;
				await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
				hanging = false;
				return assistant("文档写到一半", "aborted");
			}
			return assistant("好");
		},
	});
	await session.initialize();
	return {
		session,
		requests,
		events,
		hanging: () => hanging,
		cleanup: async () => {
			session.abort();
			await session.dispose().catch(() => {});
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		},
	};
}

test("现在就发：排在后面的话等打断的那一句做完再发，别的会话等着回答的请求进打断的那一轮", async () => {
	const h = await harness();
	try {
		const first = h.session.prompt([{ type: "text", text: "写文档" }]);
		await until(h.hanging, "第一轮卡在写文档上");
		await h.session.prompt([{ type: "text", text: "顺手跑一下测试" }], { deliver: "followUp" });
		h.session.receive(request("版本号是多少？"));

		await h.session.prompt([{ type: "text", text: "先改 README" }], { deliver: "interrupt" });
		await first;
		await until(() => !h.session.running, "全部跑完");

		assert.deepEqual(said(h.session.messages), [
			"user:写文档",
			"assistant:文档写到一半",
			"user:先改 README",
			"user:<信>",
			"assistant:好",
			"user:顺手跑一下测试",
			"assistant:好",
		], "排着的那句排在打断的那一轮后面，信在打断的那一轮里读到，各一次");
		const interrupting = h.session.messages[2]!;
		assert.equal(interrupting.role === "user" && interrupting.interrupting, true);
		assert.ok(textOf(h.session.messages[3]!).includes("版本号是多少？"), "读到的是那封请求");
		const queue = h.events.findLast((event) => event.type === "peer_queue");
		assert.deepEqual(queue?.type === "peer_queue" ? queue.letters : null, [], "读到之后待读的请求清空");
	} finally {
		await h.cleanup();
	}
});

test("现在就发时还没被循环取走的插话：进打断的那一轮，接在那一句后面，只出现一次", async () => {
	const h = await harness();
	try {
		const first = h.session.prompt([{ type: "text", text: "写文档" }]);
		await until(h.hanging, "第一轮卡在写文档上");
		// 默认是插话：循环正卡在这一次请求上，要到下一步之前才取。
		await h.session.prompt([{ type: "text", text: "用中文写" }]);

		await h.session.prompt([{ type: "text", text: "先改 README" }], { deliver: "interrupt" });
		await first;
		await until(() => !h.session.running, "全部跑完");

		assert.deepEqual(said(h.session.messages), [
			"user:写文档",
			"assistant:文档写到一半",
			"user:先改 README",
			"user:用中文写",
			"assistant:好",
		]);
		const steered = h.session.messages[3]!;
		assert.equal(steered.role === "user" && steered.steered, true, "它是打断的那一轮的输入，不另开一轮");
		const sent = h.requests.at(-1)!.messages.map(textOf);
		assert.ok(sent.some((text) => text.includes("先改 README")) && sent.some((text) => text.includes("用中文写")), "下一次请求两句都看得到");
	} finally {
		await h.cleanup();
	}
});

test("编辑重发：排在后面的话不丢，等重发的那一轮做完再发", async () => {
	const h = await harness();
	try {
		const first = h.session.prompt([{ type: "text", text: "写文档" }]);
		await until(h.hanging, "第一轮卡在写文档上");
		await h.session.prompt([{ type: "text", text: "顺手跑一下测试" }], { deliver: "followUp" });

		await h.session.editAndResend(0, [{ type: "text", text: "写 README" }]);
		await first;
		await until(() => !h.session.running, "全部跑完");

		assert.deepEqual(said(h.session.messages), ["user:写 README", "assistant:好", "user:顺手跑一下测试", "assistant:好"]);
	} finally {
		await h.cleanup();
	}
});

test("按停止：排着的话和没读到的请求照旧丢掉", async () => {
	const h = await harness();
	try {
		const first = h.session.prompt([{ type: "text", text: "写文档" }]);
		await until(h.hanging, "第一轮卡在写文档上");
		await h.session.prompt([{ type: "text", text: "顺手跑一下测试" }], { deliver: "followUp" });
		h.session.receive(request("版本号是多少？"));

		h.session.abort();
		await first;
		await new Promise((resolve) => setTimeout(resolve, 500));

		assert.deepEqual(said(h.session.messages), ["user:写文档", "assistant:文档写到一半"]);
		assert.equal(h.session.idle, true);
	} finally {
		await h.cleanup();
	}
});

test("现在就发：插话前起的后台命令跑完照样叫醒会话", async () => {
	const h = await harness();
	try {
		const first = h.session.prompt([{ type: "text", text: "写文档" }]);
		await until(h.hanging, "第一轮卡在写文档上");
		// 模型这一轮早先在后台起的构建：登记簿里在跑，结束时会话该被告知。
		const jobs = backgroundJobs(h.session.can.state);
		const job = { id: "bg1", command: "pnpm build", startedAt: Date.now(), exitCode: null, output: "", status: "running" as const };
		jobs.add({ ...job }, { pid: 1, onOutput: () => {}, onExit: () => {}, onError: () => {}, kill: () => {} });

		await h.session.prompt([{ type: "text", text: "先改 README" }], { deliver: "interrupt" });
		await first;
		await until(() => !h.session.running, "打断的那一轮跑完");

		jobs.finished({ ...job, exitCode: 0, status: "exited", finishedAt: Date.now(), output: "built in 3s\n" });
		await until(() => h.session.messages.some((message) => message.role === "user" && message.delivery?.some((one) => one.kind === "job")), "构建的结束报告送进对话");
		const delivered = h.session.messages.find((message) => message.role === "user" && message.delivery)!;
		assert.match(textOf(delivered), /pnpm build/);
	} finally {
		await h.cleanup();
	}
});
