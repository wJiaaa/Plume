/**
 * 还在写的文件，写到哪儿了：标题带上路径，行尾说写了几行。
 *
 * 几百行的文件要生成十几秒，那段时间只有「创建文件」在扫光，看不出是在往前走还是卡住了。工具卡和它所在
 * 那一段的那一行都用它——那一段默认收着，只改卡片的话，平时看到的那一行还是光秃秃的「创建文件」。
 * 开跑之后交还给记录。
 */

import type { AssistantContent } from "@plume/core";
import { useScopedFromMessages } from "../../app/session-scope.tsx";
import { translate } from "../../i18n/translate.ts";
import { argumentsSoFar, streamedLines, streamedString } from "../../lib/streamed-arguments.ts";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

/** `writing`：这次调用还没有运行记录。子智能体那份转录不在这里的消息里，传 `false`。 */
export function useWriteDraft<T extends ToolCallBlock | null>(block: T, writing: boolean): { block: T; lines?: string } {
	const drafting = writing && block?.name === "write";
	const raw = useScopedFromMessages((messages) => (drafting && block ? argumentsSoFar(messages, block.id) : null));
	if (!raw || !block) return { block };
	const path = typeof block.arguments.path !== "string" ? streamedString(raw, "path") : undefined;
	const lines = streamedLines(raw, "content");
	return {
		block: path ? { ...block, arguments: { ...block.arguments, path } } : block,
		lines: lines ? translate("toolCard.writtenLines", { n: lines }) : undefined,
	};
}
