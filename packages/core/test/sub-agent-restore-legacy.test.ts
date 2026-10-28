/**
 * 旧日志里认讨交接那一轮：认得准才剔，认不准一律留着——剔错一段真实的工作是发出错误的历史，
 * 留着多一轮只是这一次缓存不命中。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "../src/agent/events.ts";
import { planDemand } from "../src/runtime/sub-agent/checkpoint-demands.ts";
import { LegacyCheckpoints } from "../src/runtime/sub-agent/sub-agent-restore-legacy.ts";
import type { Message } from "../src/types.ts";

type Done = Extract<AgentEvent, { type: "subagent_done" }>;

/** 跑一段：`turns` 个 `turn_start`，停在 `reason`，跑完时转录长 `end`。 */
function run(legacy: LegacyCheckpoints, turns: number, reason: string, end: number): void {
	for (let turn = 1; turn <= turns; turn++) legacy.event({ type: "turn_start", turn }, end, 0);
	legacy.event({ type: "agent_end", reason } as Extract<AgentEvent, { type: "agent_end" }>, end, 0);
}

const done = (answer: string, extra: Partial<Done> = {}): Done => ({ type: "subagent_done", id: "a", steps: [], status: "done", answer, incomplete: true, ...extra });
const NOTE = (rounds: number) => `⚠ 到了检查点（这一段 ${rounds} 轮），它还没做完。下面是它交的阶段性交接，不是完整结论。`;
const said = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });

test("跑满一段之后、至多两轮、收场说到了检查点而轮数对得上的，是讨交接那一轮", () => {
	const legacy = new LegacyCheckpoints();
	run(legacy, 60, "max_turns", 120);
	run(legacy, 1, "done", 122);
	assert.equal(legacy.salvageFrom(done(NOTE(60))), 120);
});

test("认不准的都不剔", () => {
	const cases: [string, (legacy: LegacyCheckpoints) => void, Done][] = [
		// 跑满之后人插了话、它一轮就答完：那是真实的工作，收场也不会说到了检查点。
		["插话接着跑的一段", (legacy) => { run(legacy, 60, "max_turns", 120); run(legacy, 1, "done", 122); }, done("读完了", { incomplete: undefined })],
		["收场说的轮数和上一段对不上", (legacy) => { run(legacy, 60, "max_turns", 120); run(legacy, 1, "done", 122); }, done(NOTE(30))],
		["上一段不是跑满停下的", (legacy) => { run(legacy, 60, "stalled", 120); run(legacy, 1, "done", 122); }, done(NOTE(60))],
		["最后一段超过两轮", (legacy) => { run(legacy, 60, "max_turns", 120); run(legacy, 3, "done", 126); }, done(NOTE(60))],
		["检查点只有两轮，分不出哪段是讨交接", (legacy) => { run(legacy, 2, "max_turns", 10); run(legacy, 2, "max_turns", 14); }, done(NOTE(2))],
		["被按停的", (legacy) => { run(legacy, 60, "max_turns", 120); run(legacy, 1, "aborted", 121); }, done(NOTE(60), { status: "aborted" })],
		["只跑了一段", (legacy) => { run(legacy, 60, "max_turns", 120); }, done(NOTE(60))],
	];
	for (const [what, ran, ending] of cases) {
		const legacy = new LegacyCheckpoints();
		ran(legacy);
		assert.equal(legacy.salvageFrom(ending), undefined, what);
	}
});

test("续跑通知后面接的那一段，不是讨交接", () => {
	const legacy = new LegacyCheckpoints();
	run(legacy, 60, "max_turns", 120);
	legacy.event({ type: "notice", level: "info", message: "继续", code: "continue-plan" }, 120, 0);
	run(legacy, 1, "done", 122);
	assert.equal(legacy.salvageFrom(done(NOTE(60))), undefined);
});

test("续跑那句旧日志里没有就补上，新日志里已经有了就不再补", () => {
	const legacy = new LegacyCheckpoints();
	run(legacy, 60, "max_turns", 120);
	legacy.event({ type: "notice", level: "info", message: "接着", code: "continue-planless" }, 120, 1234);
	const missing = legacy.before(said("接着读"));
	assert.deepEqual(missing, planDemand(60, 1234));
	assert.equal(legacy.before(said("再读一个")), undefined, "只补一次");

	const fresh = new LegacyCheckpoints();
	run(fresh, 60, "max_turns", 120);
	fresh.event({ type: "notice", level: "info", message: "接着", code: "continue-planless" }, 120, 1234);
	assert.equal(fresh.before(planDemand(60)), undefined);
	assert.equal(fresh.before(said("接着读")), undefined);
});
