/**
 * 一条 agent 事件过 IPC 之前变成什么样子。主进程里的观察者（`broadcast` 里 `peers.observe` 那一串）
 * 拿的是原样的事件，这里只管发给窗口的那一份。
 *
 * - `turn_end` 不发：窗口里没有谁读它，而它带着整条回复和这一轮全部的工具结果，每轮每个窗口克隆一遍。
 * - 大图换成文件引用（`parkEventImages`）。
 * - 流式回复、工具进度只发变了的部分（`message-patch.ts`、`tool-patch.ts`）。
 */

import type { AgentEvent } from "@plume/core";
import type { MessagePatch, ToolPatch, WireAgentEvent } from "@plume/contract";
import { MessagePatcher } from "../../shared/message-patch.ts";
import { ToolPatcher } from "../../shared/tool-patch.ts";
import { parkEventImages } from "./display-transcript.ts";

export class EventWire {
	private readonly replies = new MessagePatcher();
	private readonly tools = new ToolPatcher();

	/** 发给窗口的那一份；`null` 是不发。 */
	wire(sessionId: string, event: AgentEvent): WireAgentEvent | null {
		if (event.type === "turn_end") return null;
		const parked = parkEventImages(event);
		const tool = this.tools.wire(sessionId, parked);
		if (tool.type === "tool_patch") return tool;
		return this.replies.wire(sessionId, tool) as WireAgentEvent;
	}

	/** 正在流的那条回复，整条作为一帧；窗口手里那份接不上补丁时来要。 */
	streamingMessage(sessionId: string): MessagePatch | null {
		return this.replies.keyframe(sessionId);
	}

	/** 正在跑的那个调用到此刻的进度，整份作为一帧。 */
	streamingTool(sessionId: string, toolCallId: string): ToolPatch | null {
		return this.tools.keyframe(sessionId, toolCallId);
	}
}
