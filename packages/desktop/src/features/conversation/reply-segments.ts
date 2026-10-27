/**
 * 一条回复按段画：连着的调用一段，连着的推理一段，其余每块一段。
 *
 * 主会话（`rows.tsx`）和子智能体面板同一套。纯数据，从 `runs.tsx` 拆出来是为了能单独测。
 */

import type { AssistantContent, ThinkingContent } from "@plume/core";

export type Segment =
	/** `last`：这一段在 `content` 里的最后一块。推理并了几块时它不是 `index`，「还在写」要问它。 */
	| { kind: "block"; block: Exclude<AssistantContent, { type: "toolCall" }>; index: number; last: number }
	| { kind: "tools"; blocks: Extract<AssistantContent, { type: "toolCall" }>[] };

/**
 * Split a reply into runs of tool calls and everything else.
 *
 * Text between two calls is a break in the run — the model stopping to explain is exactly the
 * boundary a reader uses, so folding across it would join two things it deliberately separated.
 *
 * 挨着的推理并成一块。Responses 接口的模型一次响应里能连出十几个 reasoning item，每个落成一块推理，
 * 一块一行就是一串「思考了 3 秒」。Anthropic 的一次回复里几乎不会这样，所以从前没碰上。
 */
export function segments(content: AssistantContent[]): Segment[] {
	const out: Segment[] = [];
	for (const [index, block] of content.entries()) {
		const last = out[out.length - 1];
		if (block.type === "toolCall") {
			if (last?.kind === "tools") last.blocks.push(block);
			else out.push({ kind: "tools", blocks: [block] });
		} else if (block.type === "thinking" && last?.kind === "block" && last.block.type === "thinking" && last.last === index - 1) {
			last.block = joinThoughts(last.block, block);
			last.last = index;
		} else {
			out.push({ kind: "block", block, index, last: index });
		}
	}
	return out;
}

/**
 * 两段推理并成一段：字按顺序接，时长相加，从第一段开始算起。
 *
 * 并出来的是新对象，消息里的块不动——回放给模型的仍是原来那几块。有一块看得见就给看得见的那些；
 * 一个字都没有、其中又有被过滤掉的，才说「已隐藏」。
 */
function joinThoughts(a: ThinkingContent, b: ThinkingContent): ThinkingContent {
	const thinking = [a.thinking, b.thinking].filter(Boolean).join("\n\n");
	return {
		type: "thinking",
		thinking,
		redacted: !thinking && (a.redacted === true || b.redacted === true),
		startedAt: a.startedAt ?? b.startedAt,
		durationMs: a.durationMs === undefined && b.durationMs === undefined ? undefined : (a.durationMs ?? 0) + (b.durationMs ?? 0),
	};
}
