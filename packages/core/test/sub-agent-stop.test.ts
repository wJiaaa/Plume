/**
 * 主会话的模型停掉自己派出去的子代理（`stop_subagent`）。
 *
 * 要守的是：停下的真的停了；它不再作为一条送达回来、收尾后也不再被当成「还在等的」；已经结束的、
 * 认不出来的各给一句话而不是报错；子代理自己拿不到这个工具。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { SubAgentRegistry } from "../src/runtime/sub-agent/sub-agents.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full", maxConcurrentSubAgents: 4 };

function assistant(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content: parts, api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now() };
}
const call = (id: string, name: string, args: Record<string, unknown>) => assistant([{ type: "toolCall", id, name, arguments: args, argumentsText: "{}" }], "toolUse");
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("停掉派出去的子代理：它真的停了，不再送回结果，会话也不再等它", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-stop-sub-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.PLUME_HOME = home;
	const subTools: string[][] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: () => {},
		streamFn: async (context: LlmContext, request) => {
			if (!context.tools.some((tool) => tool.name === "task")) {
				// 子代理：一直干到被停下。
				subTools.push(context.tools.map((tool) => tool.name));
				await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
				return assistant([{ type: "text", text: "读到一半" }], "aborted");
			}
			const results = context.messages.filter((message) => message.role === "toolResult");
			if (results.length === 0) return call("t1", "task", { description: "审查 a.ts", prompt: "看看 a.ts" });
			if (results.length === 1) {
				const id = /子代理 id：`([^`]+)`/.exec(textOf(results[0]!))?.[1];
				return call("t2", "stop_subagent", { id });
			}
			return assistant([{ type: "text", text: "已经停掉了。" }]);
		},
	});
	try {
		await session.initialize();
		await session.prompt([{ type: "text", text: "派一个去看 a.ts，然后不用了" }]);
		await until(() => session.subAgents.list()[0]?.status === "aborted", "子代理被停下");

		const stopped = session.log.messages.find((message) => message.role === "toolResult" && message.toolName === "stop_subagent");
		assert.match(textOf(stopped!), /已停下子代理/);
		assert.ok(!subTools.flat().includes("stop_subagent"), "子代理手里没有停别人的工具");

		// 送达攒 400ms 才发；等过这一段，确认停下的那一份没有被送回来。
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.ok(!session.log.messages.some((message) => message.role === "user" && message.delivery), "停掉的不再送回结果");
		assert.equal(session.idle, true, "没有还在等的子代理");
	} finally {
		session.abort();
		delete process.env.PLUME_HOME;
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("stop：认短 id、只停那一个；已经结束的、认不出来的各说一句", () => {
	const registry = new SubAgentRegistry();
	const aborted: string[] = [];
	registry.start({ id: "s1:sub:1a2b3c4d", agent: "general", description: "找代码", abort: () => aborted.push("1a2b3c4d") });
	registry.start({ id: "s1:sub:99999999", agent: "general", description: "另一件", abort: () => aborted.push("99999999") });

	assert.deepEqual(registry.stop("sub:1a2b3c4d"), { id: "s1:sub:1a2b3c4d" });
	assert.deepEqual(aborted, ["1a2b3c4d"], "兄弟那个不受影响");

	registry.finish("s1:sub:99999999", { status: "done", answer: "找到了" });
	assert.match((registry.stop("99999999") as { refusal: string }).refusal, /已经跑完了/);
	registry.finish("s1:sub:1a2b3c4d", { status: "aborted" });
	assert.match((registry.stop("1a2b3c4d") as { refusal: string }).refusal, /已经停下了/);
	assert.match((registry.stop("nope") as { refusal: string }).refusal, /找不到子代理/);
	assert.deepEqual(aborted, ["1a2b3c4d"], "结束了的不再扣一次扳机");
});
