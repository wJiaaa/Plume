/**
 * Every seam, replaced.
 *
 * A capability is only a seam if swapping it changes what the app does without the code that uses
 * it being edited. Each test here does exactly that and nothing else: bind a replacement, drive the
 * ordinary path, and check the replacement is what answered.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { QueuedTask } from "../src/agent/events.ts";
import { useAgentLoop, runTurn, type AgentLoop } from "../src/agent/runner.ts";
import { runConfig } from "./run-config.ts";
import { streamAssistant, useLlmRegistry } from "../src/ai/index.ts";
import { nextTask, useScheduler, type TaskScheduler } from "../src/runtime/queue/scheduling.ts";
import type { Skill } from "../src/skills/loader.ts";
import { createSkillRegistry, registeredSkills, useSkillRegistry } from "../src/skills/registry.ts";
import type { SessionStorage } from "../src/session/storage.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AgentRunResult, type AssistantMessage, type LlmContext, type ModelConfig, type Provider, type ProviderConfig } from "../src/types.ts";

test("skills: a host's skills reach the session", () => {
	const skill = { name: "deploy", description: "Ship it", source: "user" } as unknown as Skill;
	const registry = createSkillRegistry();
	registry.register([skill]);
	useSkillRegistry(registry);
	try {
		assert.deepEqual(
			registeredSkills().map((s) => s.name),
			["deploy"],
		);
	} finally {
		useSkillRegistry(null);
		assert.deepEqual(registeredSkills(), [], "and unbinding leaves none");
	}
});

test("skills: a later registration replaces one of the same name, and withdrawing it restores the first", () => {
	const registry = createSkillRegistry();
	const first = { name: "deploy", description: "first" } as unknown as Skill;
	const second = { name: "deploy", description: "second" } as unknown as Skill;
	const other = { name: "review", description: "other" } as unknown as Skill;
	registry.register([first, other]);
	const withdraw = registry.register([second]);
	assert.deepEqual(registry.all().map((s) => `${s.name}:${s.description}`), ["deploy:second", "review:other"]);
	withdraw();
	assert.deepEqual(registry.all().map((s) => `${s.name}:${s.description}`), ["deploy:first", "review:other"]);
});

test("llm: a bound registry answers first, and anything it lacks falls back to the built-in adapters", async () => {
	const said: string[] = [];
	const stub = {
		api: "openai-responses",
		// Counted when it is asked, not when it is iterated, so a lookup that merely reached it shows.
		stream() {
			said.push("stub");
			// oxlint-disable-next-line require-yield -- a provider that answers without streaming anything
			return (async function* () {
				return { role: "assistant", content: [{ type: "text", text: "from the stub" }] } as unknown as AssistantMessage;
			})();
		},
	} as unknown as Provider;
	const config = (api: string) => ({ api }) as unknown as ProviderConfig;
	const model = {} as ModelConfig;
	const context = { systemPrompt: "", messages: [] } as unknown as LlmContext;
	useLlmRegistry({ get: (api) => (api === "openai-responses" ? stub : undefined) });
	try {
		const stream = streamAssistant(config("openai-responses"), model, context);
		const done = await stream.next();
		assert.equal(done.done && (done.value.content[0] as { text: string }).text, "from the stub");
		// The registry has no answer for this one, so the built-in adapter is what streams it. Not
		// iterated: the built-in would dial out.
		streamAssistant(config("anthropic-messages"), model, context);
	} finally {
		useLlmRegistry(null);
	}
	streamAssistant(config("openai-responses"), model, context);
	assert.deepEqual(said, ["stub"], "only the bound lookup reached the stub");
});

test("scheduler: a replacement decides what runs next", () => {
	const queue = [
		{ id: "a", text: "first", status: "queued", priority: 1 },
		{ id: "b", text: "second", status: "queued", priority: 9 },
	] as unknown as QueuedTask[];

	assert.equal(nextTask(queue)?.id, "a", "the built-in order is the order they arrived");

	// Highest priority first — the point being that nothing in the session had to know.
	const byPriority: TaskScheduler = {
		next: (tasks) =>
			[...tasks]
				.filter((t) => t.status === "queued")
				.sort((x, y) => ((y as never as { priority: number }).priority ?? 0) - ((x as never as { priority: number }).priority ?? 0))[0],
	};
	useScheduler(byPriority);
	try {
		assert.equal(nextTask(queue)?.id, "b");
	} finally {
		useScheduler(null);
		assert.equal(nextTask(queue)?.id, "a");
	}
});

test("loop: a replacement drives the turn instead", async () => {
	const seen: string[] = [];
	const stub: AgentLoop = {
		async run(config) {
			seen.push(config.session.sessionId);
			return { messages: [], usage: emptyUsage(), stopReason: "stop" } as unknown as AgentRunResult;
		},
	};
	useAgentLoop(stub);
	try {
		const result = await runTurn(runConfig({ session: { sessionId: "s1" } }), () => {});
		assert.deepEqual(seen, ["s1"]);
		assert.deepEqual(result.messages, []);
	} finally {
		useAgentLoop(null);
	}
});

test("storage: the runtime accepts any store with the right shape", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-seam-"));
	try {
		// A real store satisfies the interface, which is the claim that makes it replaceable.
		const store: SessionStorage = new SessionStore(join(root, "sessions"));
		const meta = await store.create(root, "fake/model");
		const after = await store.append(meta, { type: "title", title: "renamed" });
		assert.equal(after.title, "renamed");
		assert.equal(after.seq > meta.seq, true, "append advances the sequence");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
