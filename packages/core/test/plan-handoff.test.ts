/**
 * 批准的计划写成文件；「在新会话里执行」批准后这个会话停下，压缩后也不再当成要执行的计划。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalGate } from "../src/runtime/policy/approvals.ts";
import { formatTaskContext } from "../src/runtime/compaction/task-context.ts";
import { inPlanMode, PLAN_MODE_KEY } from "../src/runtime/plan/plan-mode.ts";
import { PLAN_APPROVE, PLAN_REVISE, submitPlanTool } from "../src/runtime/plan/plan-tool.ts";
import { PLAN_HANDOFF, planSummary } from "../src/runtime/plan/plan-view.ts";
import type { ApprovedPlan, ToolContext } from "../src/types.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? "").join("");
const PLAN = { plan: "# 改登录\n\n## 概要\n加一条 OAuth 回调路由，\n复用现有的写会话。\n\n## 主要改动\n- 加 OAuth 回调（`src/auth.ts`）" };

async function fixture(scratch: boolean) {
	const scratchDir = scratch ? await mkdtemp(join(tmpdir(), "plume-plan-")) : undefined;
	const gate = new ApprovalGate({ mode: () => "full", cwd: () => "/tmp", ask: async () => {}, remember: () => {} });
	const state = new Map<string, unknown>([[PLAN_MODE_KEY, true]]);
	const ctx = { cwd: "/tmp", sessionId: "s", state, scratchDir, requestApproval: (request) => gate.request(request) } as ToolContext;
	return { gate, state, ctx, cleanup: () => (scratchDir ? rm(scratchDir, { recursive: true, force: true }) : Promise.resolve()) };
}

test("批准的计划连同注意事项写进临时目录，执行的提示里给出路径", async () => {
	const { gate, ctx, cleanup } = await fixture(true);
	try {
		const pending = submitPlanTool.execute(PLAN, ctx);
		const [request] = gate.list();
		assert.deepEqual(request!.request.options, [PLAN_APPROVE, PLAN_HANDOFF, PLAN_REVISE]);
		gate.resolve(request!.id, { answer: PLAN_APPROVE, note: "只补回调那一条" });
		const result = await pending;
		const plan = (result.details as { plan: ApprovedPlan }).plan;
		assert.ok(plan.file?.startsWith(join(ctx.scratchDir!, "plans")), plan.file);
		assert.equal(await readFile(plan.file!, "utf8"), `${PLAN.plan}\n\n## 执行时注意\n只补回调那一条\n`);
		assert.equal(plan.handoff, undefined);
		assert.equal(result.terminate, undefined, "普通批准照旧在这一轮里接着执行");
		assert.ok(textOf(result).includes(`saved at ${plan.file}`));
	} finally {
		await cleanup();
	}
});

test("在新会话里执行：计划照批、写出文件，这个会话就此停下", async () => {
	const { gate, state, ctx, cleanup } = await fixture(true);
	try {
		const pending = submitPlanTool.execute(PLAN, ctx);
		gate.resolve(gate.list()[0]!.id, { answer: PLAN_HANDOFF });
		const result = await pending;
		const plan = (result.details as { kind: string; plan: ApprovedPlan }).plan;
		assert.equal((result.details as { kind: string }).kind, "plan", "计划面板和压缩快照照样认它是批准的");
		assert.equal(plan.handoff, true);
		assert.equal(await readFile(plan.file!, "utf8"), `${PLAN.plan}\n`);
		assert.equal(inPlanMode(state), false);
		assert.equal(result.terminate, true, "接着跑就是两个会话在同一份计划上各改各的");
		assert.match(textOf(result), /Do not carry it out here/);
	} finally {
		await cleanup();
	}
});

test("交接时挑的模型记在批准的计划上；原地执行的批准带了也不记", async () => {
	for (const [answer, expected] of [[PLAN_HANDOFF, "p/model-a"], [PLAN_APPROVE, undefined]] as const) {
		const { gate, ctx, cleanup } = await fixture(true);
		try {
			const pending = submitPlanTool.execute(PLAN, ctx);
			gate.resolve(gate.list()[0]!.id, { answer, modelId: "p/model-a" });
			assert.equal(((await pending).details as { plan: ApprovedPlan }).plan.modelId, expected);
		} finally {
			await cleanup();
		}
	}
});

test("没有临时目录的宿主不给交接这一项，那句话只当打回的理由", async () => {
	const { gate, state, ctx } = await fixture(false);
	const pending = submitPlanTool.execute(PLAN, ctx);
	const [request] = gate.list();
	assert.deepEqual(request!.request.options, [PLAN_APPROVE, PLAN_REVISE]);
	gate.resolve(request!.id, { answer: PLAN_HANDOFF });
	const result = await pending;
	assert.equal((result.details as { kind: string }).kind, "plan-feedback");
	assert.equal(inPlanMode(state), true);
});

test("压缩后：交出去的计划不再叫这个会话执行，自己的计划带上文件路径", () => {
	const base: ApprovedPlan = { ...PLAN, file: "/scratch/plans/plan-1.md", approvedAt: 1 };
	const handed = formatTaskContext({ plan: { ...base, handoff: true } });
	assert.match(handed, /handed to another session that carries it out from \/scratch\/plans\/plan-1\.md \(do not carry it out here/);
	assert.doesNotMatch(handed, /execute it/);
	assert.match(formatTaskContext({ plan: base }), /User-approved plan \(execute it; re-plan only if the user says so\), saved at \/scratch\/plans\/plan-1\.md:/);
});

test("概要取「概要」那一节的第一段；没有这一节取标题下面第一段；太长截断", () => {
	assert.equal(planSummary(PLAN), "加一条 OAuth 回调路由， 复用现有的写会话。");
	assert.equal(planSummary({ plan: "# 改登录\n\n先加路由。\n\n## 改动\n- a" }), "先加路由。");
	assert.equal(planSummary({ plan: "## Summary:\nAdd the route.\n\n## Changes" }), "Add the route.");
	assert.equal(planSummary({ plan: "# 只有标题" }), "");
	const long = planSummary({ plan: `# t\n\n${"字".repeat(400)}` });
	assert.equal(long.length, 301);
	assert.ok(long.endsWith("…"));
});
