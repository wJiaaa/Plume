import type { ToolResult } from "@plume/core";

/** Shared transcript data must not depend on either conversation's live store. */
export interface ToolRun {
	toolCallId: string;
	toolName: string;
	summary: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	result?: ToolResult;
	startedAt: number;
	finishedAt?: number;
}

/** 会把这一轮挂在另一个会话上的工具：问了等回答，或接着等。 */
export function waitsOnSession(toolName: string): boolean {
	return toolName === "ask_session" || toolName === "wait_for_session";
}

/**
 * 主会话此刻卡在等另一个会话做完（`ask_session` / `wait_for_session`）上。
 *
 * 和等子代理是同一回事：这时候人说的话该直接送进去，运行时会让它放手、先回应人（`untilSpokenTo`），
 * 而不是在输入框上方排到对方做完为止——那可能是十分钟。
 */
export function awaitingSession(runs: Record<string, ToolRun>): boolean {
	return Object.values(runs).some((run) => waitsOnSession(run.toolName) && run.status === "running");
}
