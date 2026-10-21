/**
 * 用量页「Token 构成」「耗时构成」两张环图背后的算术。
 *
 * 和画图分开放，理由同 `usage-requests.ts`：思考要从生成里扣出来、会话要去重而不是按天相加，
 * 这几件事错了在环图上看不出来——每一段都还是一段。
 */

import { INPUT_PARTS, OUTPUT_PARTS, type InputPart, type OutputPart } from "@plume/core/usage-parts";
import type { UsageActivity } from "../../../electron/usage-scan.ts";
import { filterRequests, type RequestFilter } from "./usage-requests.ts";

export type TokenPart = InputPart | OutputPart;
export const TOKEN_PARTS: readonly TokenPart[] = [...INPUT_PARTS, ...OUTPUT_PARTS];

export interface ActivityTotals extends Record<TokenPart, number> {
	/** 区间里有过动静的会话，跨天、跨模型去重。 */
	sessions: number;
	archived: number;
	turns: number;
	replies: number;
	timedReplies: number;
	modelMs: number;
	streamMs: number;
	thinkingMs: number;
	tools: number;
	toolErrors: number;
	toolMs: number;
}

const SUMMED = ["turns", "replies", "timedReplies", "modelMs", "streamMs", "thinkingMs", "tools", "toolErrors", "toolMs", ...TOKEN_PARTS] as const;

/** 和请求那一栏同一套筛选：区间、供应商、搜索。行是按天的，按小时的 `hour` 用当天零点代入。 */
export function activityTotals(rows: UsageActivity[], filter: RequestFilter, describe: (row: Pick<UsageActivity, "provider" | "model">) => string): ActivityTotals {
	const totals = { sessions: 0, archived: 0 } as ActivityTotals;
	for (const key of SUMMED) totals[key] = 0;
	const seen = new Set<string>();
	const kept = filterRequests(rows.map((row) => ({ ...row, hour: `${row.day} 00` })), filter, describe);
	for (const row of kept) {
		if (!seen.has(row.session)) {
			seen.add(row.session);
			totals.sessions += 1;
			if (row.archived) totals.archived += 1;
		}
		for (const key of SUMMED) totals[key] += row[key];
	}
	return totals;
}

export interface Segment {
	key: string;
	value: number;
	color: string;
}

/**
 * 一次调用的时间：发出请求到第一个 token 是等，之后是生成，生成里有思考块的那段算思考、其余算回复。
 * 工具执行另起一段。回放已经把思考截在生成以内（core 的 `usage-replay.ts`），这里的减法不会出负数。
 */
export function timeSegments(totals: ActivityTotals): Segment[] {
	return [
		{ key: "wait", value: totals.modelMs - totals.streamMs, color: "var(--color-accent)" },
		{ key: "thinking", value: totals.thinkingMs, color: "var(--color-violet)" },
		{ key: "reply", value: totals.streamMs - totals.thinkingMs, color: "var(--ly-chart-5)" },
		{ key: "tool", value: totals.toolMs, color: "var(--ly-chart-2)" },
	];
}

/*
 * 十种颜色：提示词那四类走蓝、黄两个色系里的深浅，消息四类各自一色，输出两类用紫和玫红。紫色只给
 * 思考：助手消息用过紫色，和「输出 · 思考」两个点并排时分不开。注入内容是系统塞进来的，用中性灰。
 */
const TOKEN_COLORS: Record<TokenPart, string> = {
	system: "var(--color-accent)",
	instructions: "color-mix(in oklab, var(--color-accent) 50%, white)",
	skills: "var(--ly-chart-3)",
	toolDefs: "color-mix(in oklab, var(--ly-chart-3) 50%, var(--ly-chart-5))",
	user: "var(--color-ok)",
	injected: "color-mix(in oklab, var(--color-ink) 45%, transparent)",
	assistant: "var(--ly-chart-6)",
	toolResults: "var(--ly-chart-2)",
	outputThinking: "var(--color-violet)",
	outputReply: "var(--ly-chart-5)",
};

/** 每次请求送进去的各部分和吐出来的两部分，加起来是这些回复计费的全部 token（含缓存读写）。 */
export function tokenSegments(totals: ActivityTotals): Segment[] {
	return TOKEN_PARTS.map((key) => ({ key, value: totals[key], color: TOKEN_COLORS[key] }));
}
