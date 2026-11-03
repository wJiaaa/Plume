/**
 * 一轮改过代码之后，有没有跑过检查、过没过——交付卡片和会话体检用的是同一个判断。
 *
 * 只说事实，不拦这一轮：不是每件事都要验证，而哪些要没有可靠的信号（agent-cost-and-stopping.md F 组）。
 * 所以卡片只在跑过检查时说结果；`unverified` 只进体检，不上界面。
 */

import type { Message } from "./types.ts";

/**
 * 是不是一条检查命令。启发式：`npx tsc`、`make` 认不出，`go run`、`cargo run` 会被当成检查。
 * 要补就看 `pnpm audit:sessions` 里这一节的误判，再改这里。
 */
export function isCheckCommand(command: string): boolean {
	return /(?:^|[\s/])(?:test|check|lint|typecheck|pytest|jest|vitest|cargo|go)(?:[\s:]|$)/i.test(command);
}

/**
 * - `passed` / `failed`：最后一次改文件之后，最后那条检查命令的结果
 * - `pending`：检查放到了后台或交给了 `verify` 子代理，结果不在这一轮的工具结果里
 * - `unverified`：最后一次改文件之后没有检查
 */
export type TurnVerification = { state: "passed" | "failed" | "pending"; command: string } | { state: "unverified" };

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * 只改文档不需要检查：本机未验证的轮次里约 13% 只动了 Markdown，给它们挂一行「没跑检查」是噪音。
 * 命令改的文件结果里没有路径，一律当代码。
 */
const DOCUMENT = /\.(?:md|mdx|txt|rst)$/i;

/** 这条结果改没改代码。和交付卡片列文件时认的是同一组字段（`changeId`、`changeIds`）。 */
function changedCode(message: Message & { role: "toolResult" }, detail: Record<string, unknown>): boolean {
	if (Array.isArray(detail.changeIds) && detail.changeIds.length > 0) return true;
	return !message.isError && typeof detail.changeId === "string" && !(typeof detail.path === "string" && DOCUMENT.test(detail.path));
}

/** 一轮的消息（从人那句话到这轮的回答），没改代码时是 `null`。 */
export function turnVerification(messages: readonly Message[]): TurnVerification | null {
	let edited = false;
	let check: TurnVerification = { state: "unverified" };
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const detail = record(message.details);
		if (!detail) continue;
		const command = typeof detail.command === "string" ? detail.command : null;
		/*
		 * 检查命令自己顺带写出来的文件（快照、锁文件）不算「检查之后又改了」：那是这次检查的一部分，
		 * 算进去的话，`cargo test` 每更新一次 Cargo.lock 都会被报成没验证。
		 */
		if (command !== null && isCheckCommand(command)) {
			if (!edited) continue;
			// 不能只看 `isError`：`bash_output` 读回后台任务的结果时从不置它，非零退出照样是 false。
			if (typeof detail.exitCode === "number") check = { state: detail.exitCode === 0 && !message.isError ? "passed" : "failed", command };
			// 超时转后台、主动放后台的，结果稍后作为一条消息送回来；没有退出码又报错的，是被中断了。
			else check = { state: detail.kind === "bash_background" || detail.backgrounded === true || !message.isError ? "pending" : "failed", command };
			continue;
		}
		if (changedCode(message, detail)) {
			edited = true;
			check = { state: "unverified" };
			continue;
		}
		if (edited && detail.kind === "task" && detail.agentType === "verify") check = { state: "pending", command: "verify" };
	}
	return edited ? check : null;
}
