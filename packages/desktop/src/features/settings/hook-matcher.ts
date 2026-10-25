/**
 * 一条钩子的匹配器在它那个事件上拿什么去比。
 *
 * 照的是 core 里各事件实际传的值（`packages/core/src/runtime/policy/hooks.ts` 的 `matchValues`）：
 * 工具类事件比工具名，SessionStart 比会话怎么开始，StopFailure、SessionEnd 比结束原因。
 * UserPromptSubmit 和 Stop 什么也不传——那里写了匹配器，钩子就一次也不会跑（`matchesHookMatcher`
 * 遇到空值直接判不中），所以表单在这两个事件上把它关掉，而不是让人填一个静默失效的东西。
 */

import type { HookEventName } from "@plume/core";

export type MatcherSubject = "tool" | "start" | "turnEnd" | "sessionEnd";

const SUBJECTS: Record<HookEventName, MatcherSubject | null> = {
	SessionStart: "start",
	UserPromptSubmit: null,
	PreToolUse: "tool",
	PermissionRequest: "tool",
	PostToolUse: "tool",
	PostToolUseFailure: "tool",
	Stop: null,
	StopFailure: "turnEnd",
	SessionEnd: "sessionEnd",
};

/** null 是这个事件不看匹配器。 */
export function matcherSubject(event: HookEventName): MatcherSubject | null {
	return SUBJECTS[event];
}
