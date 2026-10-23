/**
 * 派完子智能体就收尾的那一轮，在会话列表上不算做完。
 *
 * 子智能体派出即放手：主回合当场 `agent_end`，它们还在后台跑，结果回来再开一轮。从前列表只看
 * 主回合，这一段里那一行显示「已完成」、还报一声做完了；等结果回来又亮起来、再报一次。
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { AgentEvent, SubAgentSummary } from "@plume/core";
import { useSubAgents, delegating } from "../src/store/subAgents.ts";
import { rowActivity } from "../src/lib/row-activity.ts";

// 后台会话收尾时会去重读会话列表；这里只关心 activity。
(globalThis as { plume?: unknown }).plume = { sessions: { list: async () => [] } };

const { applyAgentEvent } = await import("../src/store/apply-event.ts");

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function agent(status: SubAgentSummary["status"]): SubAgentSummary {
	return { id: "sub-1", agent: "explore", description: "查一下", status, startedAt: 0, toolCalls: 0, usage };
}

function harness() {
	const notices: string[] = [];
	const state: Record<string, unknown> = {
		activity: {}, turns: {}, carried: {}, sessions: [], activeSessionId: "main", messages: [], toolRuns: {}, commandRuns: [], compactions: [],
		sessionCache: {}, queued: {}, running: false, notify: (text: string) => notices.push(text), flushQueue: () => {},
	};
	const fold = (event: AgentEvent) =>
		applyAgentEvent("other", event, (partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial), () => state as never);
	const row = () => rowActivity((state.activity as Record<string, never>).other ?? null, delegating(useSubAgents.getState().rosters.other), false);
	return { state, notices, fold, row };
}

beforeEach(() => {
	useSubAgents.setState({ rosters: {} });
});

test("the row keeps running while dispatched sub-agents work, and finishes once with the turn their results start", () => {
	const { notices, fold, row } = harness();
	fold({ type: "agent_start" } as AgentEvent);
	fold({ type: "subagents", agents: [agent("running")] } as AgentEvent);
	fold({ type: "agent_end", reason: "done" } as AgentEvent);
	assert.equal(row(), "running");
	assert.deepEqual(notices, []);

	fold({ type: "subagents", agents: [agent("done")] } as AgentEvent);
	fold({ type: "agent_start" } as AgentEvent);
	assert.equal(row(), "running");
	fold({ type: "agent_end", reason: "done" } as AgentEvent);
	assert.equal(row(), "done");
	assert.equal(notices.length, 1);
});

test("a turn that fails while sub-agents are out still says so", () => {
	const { fold, row, notices } = harness();
	fold({ type: "agent_start" } as AgentEvent);
	fold({ type: "subagents", agents: [agent("running")] } as AgentEvent);
	fold({ type: "agent_end", reason: "error" } as AgentEvent);
	assert.equal(row(), "running");
	fold({ type: "subagents", agents: [agent("aborted")] } as AgentEvent);
	assert.equal(row(), "failed");
	assert.equal(notices.length, 1);
});

test("sub-agents a person stopped leave the row idle rather than stuck running", () => {
	const { fold, row } = harness();
	fold({ type: "agent_start" } as AgentEvent);
	fold({ type: "subagents", agents: [agent("running")] } as AgentEvent);
	fold({ type: "agent_end", reason: "done" } as AgentEvent);
	fold({ type: "subagents", agents: [agent("aborted")] } as AgentEvent);
	assert.equal(row(), null);
});
