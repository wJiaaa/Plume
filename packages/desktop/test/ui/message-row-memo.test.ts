/**
 * 流式时转录每个 token 都重新分组一次，每一行都会拿到一份新的 `turnStats`。数字没变的行不该跟着重画——
 * 否则窗口里每一条助手行都在每个 token 上重渲染，只为了写出来的那一行。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@plume/core";
import { sameRow } from "../../src/features/conversation/rows.tsx";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "做完了。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 10 };
const stats = (durationMs: number) => ({ durationMs, requestMs: 800, sseDurationMs: 600, outputTokens: 120, requestCount: 2, startIndex: 0 });
const props = (over: Record<string, unknown> = {}) => ({ message, index: 0, upTo: 1, turnStats: stats(5000), ...over });

test("同样数字的一份新 turnStats 算同一行，数字变了才算变了", () => {
	assert.equal(sameRow(props(), props()), true, "又一次分组交来的同一组数字，不是这一行的变化");
	assert.equal(sameRow(props(), props({ turnStats: stats(6000) })), false, "耗时真的变了，页脚要跟着重画");
	assert.equal(sameRow(props(), props({ turnStats: undefined })), false, "有页脚和没页脚是两回事");
});

test("其余的属性照旧按引用比", () => {
	assert.equal(sameRow(props(), props({ message: { ...message } })), false, "消息换了一个对象，就是这一行变了");
	assert.equal(sameRow(props(), props({ showTime: true })), false, "多出一个属性也算变了");
});
