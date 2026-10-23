/**
 * 计划审批卡上的「在新会话里执行」：主会话里讨论、审核、批准，实施在一个只带着这份计划的新会话里开始。
 *
 * 为什么另开会话而不是原地执行：几轮讨论和审核留在实施的上下文里，旧版计划、打回意见、为核实而读的
 * 代码都跟着实施走到底——一个真实会话里这部分占了一半。新会话的第一条消息只有标题、概要、计划文件
 * 和两条规矩；计划全文在文件里，压缩以后路径还在，随时能重读。
 *
 * core 的 `submit_plan` 批准、写文件、让主会话停下；这里看到那次结果就开会话，和建议卡片开出来的
 * 一样挂在主会话下面（`spawnedFrom`），不回报——主会话留着只为回答那边的提问。
 */

import type { AgentEvent, ApprovedPlan, SessionMeta } from "@plume/core";
import { approvedPlanOf, planSummary, planTitle, SUBMIT_PLAN_TOOL_NAME } from "@plume/core/plan-view";
import { nativeText } from "../i18n.ts";
import { peerAddress } from "../peer/index.ts";

export interface PlanHandoffDeps {
	/** 交出计划的那个会话此刻的 meta。 */
	meta(sessionId: string): SessionMeta | undefined;
	/** 开新会话并让它开始第一轮。 */
	start(parent: SessionMeta, toolCallId: string, title: string, prompt: string): Promise<void>;
	/** 没开出来：主会话那一轮已经按「交出去了」停下，不告诉人的话这份计划就悄悄没人做了。 */
	failed(parentId: string, message: string): void;
}

/**
 * 新会话的第一条消息。
 *
 * 只说计划文件里没有的：要做的是什么（概要）、以哪份为准、能做到哪一步、拿不准时问谁。授权范围写死
 * 而不是让模型临场写：计划批的是改代码和验证，提交、推送这类外部可见的动作从来不在批准里。
 * 「能从代码查到的自己查」那一句是为主会话省钱：不加的话每碰到一点不确定就问一次，每问一次那边就多跑一轮。
 */
export function handoffPrompt(plan: ApprovedPlan & { file: string }, parent: Pick<SessionMeta, "id" | "title" | "cwd">): string {
	const summary = planSummary(plan);
	return [
		nativeText("planHandoff.title", { title: planTitle(plan) }),
		...(summary ? [summary] : []),
		[
			nativeText("planHandoff.file", { file: plan.file }),
			nativeText("planHandoff.scope"),
			nativeText("planHandoff.questions", { address: peerAddress(parent) }),
		].join("\n"),
	].join("\n\n");
}

export function handOffApprovedPlans(deps: PlanHandoffDeps): { observe(sessionId: string, event: AgentEvent): void } {
	// 一次批准只开一个会话。
	const started = new Set<string>();
	return {
		observe(sessionId, event) {
			if (event.type !== "tool_end" || event.toolName !== SUBMIT_PLAN_TOOL_NAME || event.isError) return;
			const plan = approvedPlanOf(event.result.details);
			if (!plan?.handoff || !plan.file || started.has(event.toolCallId)) return;
			const parent = deps.meta(sessionId);
			if (!parent) return;
			started.add(event.toolCallId);
			const file = plan.file;
			void deps.start(parent, event.toolCallId, planTitle(plan).slice(0, 60), handoffPrompt({ ...plan, file }, parent)).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				deps.failed(sessionId, nativeText("planHandoff.failed", { reason, file }));
			});
		},
	};
}
