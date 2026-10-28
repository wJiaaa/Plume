import { create } from "zustand";
import type { AgentEvent } from "@plume/core";
import { describeCall } from "../lib/tool-kinds.ts";

/**
 * 每个会话最近开始的那一步，读成转录里的说法（「读取 pom.xml」「执行命令 mvn test」）。
 *
 * 给交出去的会话用：计划交接、建议卡片、审阅开出来的会话，在主会话输入框上方各有一行（`HandedOffStrip`），
 * 那边在读什么、跑什么不点过去也该看得见。只记一句，不记过程——过程在那个会话自己的转录里，在这里再画
 * 一遍是同一件事说两遍。
 *
 * `apply-event.ts` 按事件写，每个会话都写：事件本来就全到这里，哪个会话会被哪一行读，这里不必知道。
 * 一轮结束就清掉，不留一句已经不在做的事。
 */

export const useSessionDoing = create<{ bySession: Record<string, string> }>(() => ({ bySession: {} }));

export function noteSessionDoing(sessionId: string, event: AgentEvent): void {
	if (event.type === "tool_start") {
		const doing = describeCall(event.toolName, event.summary);
		useSessionDoing.setState((state) => (state.bySession[sessionId] === doing ? state : { bySession: { ...state.bySession, [sessionId]: doing } }));
	} else if (event.type === "agent_end") {
		useSessionDoing.setState((state) => {
			if (!(sessionId in state.bySession)) return state;
			const { [sessionId]: _done, ...rest } = state.bySession;
			return { bySession: rest };
		});
	}
}
