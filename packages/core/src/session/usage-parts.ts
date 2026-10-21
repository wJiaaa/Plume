/**
 * 用量页 Token 构成的几类，回放（`usage-replay.ts`）和渲染进程的环图共用。
 *
 * 单独一个文件、什么都不引：渲染进程经 `@plume/core/usage-parts` 拿它，而回放连着 `agent/prune.ts`，
 * 不能进浏览器。
 */

/** 输入按来源分的几类。系统提示词按 `PromptSection.source` 拆成前三类。 */
export const INPUT_PARTS = ["system", "instructions", "skills", "toolDefs", "user", "injected", "assistant", "toolResults"] as const;
export type InputPart = (typeof INPUT_PARTS)[number];
export const OUTPUT_PARTS = ["outputThinking", "outputReply"] as const;
export type OutputPart = (typeof OUTPUT_PARTS)[number];
