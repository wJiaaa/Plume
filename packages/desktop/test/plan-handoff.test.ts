/**
 * 「在新会话里执行」：批准的计划带着交接标记出来，就开一个会话、只开一次；第一条消息是标题、概要、
 * 计划文件和两条规矩；没开出来要告诉人。规则在 `electron/session/plan-handoff.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, ApprovedPlan, SessionMeta } from "@plume/core";
import { handoffPrompt, handOffApprovedPlans } from "../electron/session/plan-handoff.ts";

const PLAN: ApprovedPlan = { plan: "# 敏感日志分文件\n\n## 概要\n五个模块的敏感日志写到单独的文件。\n\n## 改动\n- …", file: "/scratch/s-main/plans/plan-1.md", handoff: true, approvedAt: 1 };
const PARENT = { id: "67df5000-119b-4508-b75a-757060836edf", title: "敏感日志分文件输出优化", cwd: "/work/eim" } as SessionMeta;
const approved = (plan: ApprovedPlan, toolCallId = "call-1"): AgentEvent => ({
	type: "tool_end", toolCallId, toolName: "submit_plan", isError: false,
	result: { content: [{ type: "text", text: "approved" }], details: { kind: "plan", plan } },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(fail?: string) {
	const started: { parent: string; toolCallId: string; title: string; prompt: string }[] = [];
	const failures: { parentId: string; message: string }[] = [];
	const watcher = handOffApprovedPlans({
		meta: (id) => (id === PARENT.id ? PARENT : undefined),
		start: async (parent, toolCallId, title, prompt) => {
			if (fail) throw new Error(fail);
			started.push({ parent: parent.id, toolCallId, title, prompt });
		},
		failed: (parentId, message) => failures.push({ parentId, message }),
	});
	return { watcher, started, failures };
}

test("交接的批准开一个挂在主会话下的会话，同一次批准只开一次", async () => {
	const { watcher, started } = host();
	watcher.observe(PARENT.id, approved(PLAN));
	watcher.observe(PARENT.id, approved(PLAN));
	await settle();
	assert.equal(started.length, 1);
	assert.deepEqual({ ...started[0], prompt: undefined }, { parent: PARENT.id, toolCallId: "call-1", title: "敏感日志分文件", prompt: undefined });
});

test("普通批准、打回、出错、没有文件的都不开", async () => {
	const { watcher, started } = host();
	watcher.observe(PARENT.id, approved({ ...PLAN, handoff: undefined }, "a"));
	watcher.observe(PARENT.id, approved({ ...PLAN, file: undefined }, "b"));
	watcher.observe(PARENT.id, { ...approved(PLAN, "c"), isError: true } as AgentEvent);
	watcher.observe(PARENT.id, { type: "tool_end", toolCallId: "d", toolName: "submit_plan", isError: false, result: { content: [], details: { kind: "plan-feedback", feedback: "再想想" } } });
	watcher.observe(PARENT.id, { ...approved(PLAN, "e"), toolName: "read" } as AgentEvent);
	await settle();
	assert.equal(started.length, 0);
});

test("没开出来就在主会话里说一声，带上计划文件的位置", async () => {
	const { watcher, failures } = host("disk full");
	watcher.observe(PARENT.id, approved(PLAN));
	await settle();
	assert.equal(failures.length, 1);
	assert.equal(failures[0]!.parentId, PARENT.id);
	assert.match(failures[0]!.message, /disk full/);
	assert.ok(failures[0]!.message.includes(PLAN.file!));
});

test("第一条消息：标题、概要、计划文件、授权范围、问谁——不抄计划正文", () => {
	const prompt = handoffPrompt({ ...PLAN, file: PLAN.file! }, PARENT);
	const [title, summary, rules] = prompt.split("\n\n");
	assert.equal(title, "按已批准的计划实施：敏感日志分文件");
	assert.equal(summary, "五个模块的敏感日志写到单独的文件。");
	assert.ok(rules!.includes(PLAN.file!));
	assert.ok(rules!.includes("「敏感日志分文件输出优化 [67df50]」"), "地址和 list_sessions 给的一样，ref 是 id 的前六位");
	assert.match(rules!, /ask_session/);
	assert.match(rules!, /提交、推送/);
	assert.doesNotMatch(prompt, /## 改动/);
});
