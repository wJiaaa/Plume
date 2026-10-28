/**
 * 「现在就发」停的是这一轮，不是派出去的子代理。
 *
 * 从前插话走的是停止按钮那一套：后台子代理全部停掉、放了手的名单清空、跑完待送的报告扔掉、排着的
 * 任务取消。模型手里只有派发时那句「结论依赖它的结果，回来之前不要写结论」，没有人告诉它子代理已经
 * 停了——它就一直等一个永远不会来的结果。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model", providerId: "fake", modelId: "m", name: "Fake", contextWindow: 100_000,
	maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true,
};
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = {
	...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full",
	maxConcurrentSubAgents: 4, subAgentDelegation: "eager",
};

const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
	({ role: "assistant", content, api: "openai-responses", provider: "fake", model: "m", usage: emptyUsage(), stopReason, timestamp: Date.now() });
const says = (text: string) => assistant([{ type: "text", text }]);
const textOf = (message: Message) => (Array.isArray(message.content) ? message.content.map((part) => ("text" in part ? part.text : "")).join("") : message.content);
const saw = (context: LlmContext, text: string) => context.messages.some((message) => message.role === "user" && textOf(message).includes(text));

/** 等到放行或被停下，哪个先来算哪个。 */
const hold = (gate: Promise<void>, signal: AbortSignal | undefined) =>
	new Promise<"released" | "aborted">((resolve) => {
		if (signal?.aborted) return resolve("aborted");
		signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
		void gate.then(() => resolve("released"));
	});

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("在派活的那一轮里点「现在就发」：后台子代理接着跑，跑完照样送回来", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-interrupt-bg-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	const saved = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	Object.assign(process.env, { PLUME_HOME: home, HOME: home, USERPROFILE: home });

	let finish!: () => void;
	const finished = new Promise<void>((resolve) => (finish = resolve));
	let hanging = false;
	const delivered: LlmContext[] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: () => {},
		streamFn: async (context, request) => {
			if (!context.tools.some((tool) => tool.name === "task")) {
				if (context.tools.length === 0) return says("{}");
				// 子代理：等测试放行。挂在它自己的信号上——被连带停掉的话这里当场就会知道。
				return (await hold(finished, request.signal)) === "aborted" ? assistant([], "aborted") : says("报告：a.ts:12 没判空。");
			}
			if (context.messages.some((message) => message.role === "user" && message.delivery)) {
				delivered.push(context);
				return says("合并好了。");
			}
			if (saw(context, "插一句")) return says("好，先回答你这句。");
			if (!context.messages.some((message) => message.role === "toolResult")) {
				return assistant([{ type: "toolCall", id: "t1", name: "task", arguments: { description: "审查 a.ts", prompt: "看看 a.ts", subagent_type: "general" }, argumentsText: "{}" }], "toolUse");
			}
			// 派完之后的下一步：卡在这里，等人插话。
			hanging = true;
			await hold(new Promise(() => {}), request.signal);
			return assistant([], "aborted");
		},
	});
	await session.initialize();
	try {
		const first = session.prompt([{ type: "text", text: "派一个去审查 a.ts" }]);
		await until(() => hanging, "派完活之后卡在下一步");
		const [id] = session.subAgents.list().map((one) => one.id);
		assert.ok(id, "子代理已经派出去了");

		await session.prompt([{ type: "text", text: "插一句" }], { deliver: "interrupt" });
		await first;
		assert.equal(session.subAgents.detail(id)?.status, "running", "插话停的是这一轮，子代理还在跑");

		finish();
		await until(() => delivered.length > 0, "跑完的结果送回主会话");
		assert.ok(textOf(delivered[0].messages.findLast((message) => message.role === "user" && message.delivery)!).includes("a.ts:12"), "送回来的是它的报告");
		assert.equal(session.subAgents.detail(id)?.status, "done");
	} finally {
		finish();
		session.abort();
		await session.dispose().catch(() => {});
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
