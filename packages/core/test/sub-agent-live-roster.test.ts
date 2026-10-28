/** 运行中开关智能体：走真实的设置重载，不能用原地修改数组代替生产路径。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { StreamFn } from "../src/agent/run-config.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/agent-session/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { AGENTS_KEY } from "../src/tools/task.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model", providerId: "fake", modelId: "model", name: "Fake",
	contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true,
};
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full", autoSummarizeTitle: false };
const says = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() });
const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage => ({ ...says(""), content: [{ type: "toolCall", id, name, arguments: args, argumentsText: JSON.stringify(args) }], stopReason: "toolUse" });
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");

async function until(check: () => boolean, what: string): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > 5000) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function fixture(t: TestContext, disabledAgents: string[]) {
	const root = await mkdtemp(join(tmpdir(), "ly-live-agents-"));
	const home = join(root, "home");
	await mkdir(home);
	const previous = { PLUME_HOME: process.env.PLUME_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	for (const key of Object.keys(previous)) process.env[key] = home;
	const store = new SessionStore(join(root, "sessions"));
	let reply: StreamFn = async () => says("好了");
	let reloaded = Promise.withResolvers<void>();
	const session = new AgentSession({
		cwd: root, settings: { ...SETTINGS, disabledAgents }, store,
		emit: (event) => { if (event.type === "capabilities_changed") reloaded.resolve(); },
		streamFn: (context, request) => reply(context, request),
	});
	t.after(async () => {
		try {
			await session.dispose();
			await until(() => !session.subAgents.list().some((one) => one.status === "running" || one.status === "queued"), "子代理收尾");
		} finally {
			store.close();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		}
	});
	await session.initialize();
	return {
		session,
		async reload(off: string[]) {
			assert.equal(session.running, true, "开关发生在同一轮运行中");
			const before = session.can.agents;
			reloaded = Promise.withResolvers<void>();
			session.updateSettings({ ...SETTINGS, disabledAgents: off });
			await reloaded.promise;
			assert.notEqual(session.can.agents, before, "生产重载替换数组，不是 splice 旧数组");
			assert.equal(session.can.state.get(AGENTS_KEY), session.can.agents);
		},
		async run(stream: StreamFn) {
			reply = stream;
			await session.prompt([{ type: "text", text: "检查子代理开关" }]);
			await until(() => session.idle, "本轮及后台送达收尾");
		},
	};
}

test("运行中启用 review：新派发使用 review 的指令和只读工具，不退成 general", { timeout: 10_000 }, async (t) => {
	const h = await fixture(t, ["review"]);
	const requests: LlmContext[] = [];
	let parents = 0;
	await h.run(async (context) => {
		if (!context.tools.some((tool) => tool.name === "task")) {
			requests.push(context);
			return says("已检查，没有缺陷。");
		}
		if (parents++ === 0) {
			await h.reload([]);
			return call("dispatch-review", "task", { description: "检查改动", prompt: "只读检查", subagent_type: "review" });
		}
		return says("等待审查结果。");
	});
	assert.equal(h.session.subAgents.list()[0]?.agent, "review");
	assert.equal(requests.length, 1);
	assert.match(requests[0]!.systemPrompt, /You are a code review agent/);
	const tools = new Set(requests[0]!.tools.map((tool) => tool.name));
	assert.ok(tools.has("read"));
	for (const name of ["write", "edit", "task", "stop_subagent"]) assert.ok(!tools.has(name), name);
});

test("运行中禁用 simple：同一轮的 resume 被拒绝，不再发出子代理请求", { timeout: 10_000 }, async (t) => {
	const h = await fixture(t, []);
	let parents = 0;
	let subRequests = 0;
	await h.run(async (context) => {
		if (!context.tools.some((tool) => tool.name === "task")) {
			subRequests++;
			return says("第一段做完了。");
		}
		if (parents++ === 0) return call("dispatch-simple", "task", { description: "做一段", prompt: "做第一段", subagent_type: "simple" });
		if (parents === 2) {
			await until(() => h.session.subAgents.list()[0]?.resumable === true, "simple 留下可恢复上下文");
			const id = h.session.subAgents.list()[0]!.id;
			await h.reload(["simple"]);
			return call("resume-simple", "task", { description: "接着做", prompt: "做第二段", resume: id });
		}
		return says("停止派发。");
	});
	const result = h.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "resume-simple");
	assert.ok(result?.role === "toolResult" && result.isError);
	assert.match(textOf(result), /no longer available/);
	assert.equal(subRequests, 1, "禁用之后没有第二段请求");
	assert.equal(h.session.subAgents.list()[0]?.resumes ?? 0, 0);
});
