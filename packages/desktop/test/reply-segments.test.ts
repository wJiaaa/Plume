/**
 * 一条回复按段画时，挨着的推理并成一段。
 *
 * Responses 接口的模型说完一句话后能在同一次响应里连出十几个 reasoning item，从前一块一行，
 * 转录上是一串「思考了 3 秒」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantContent } from "@plume/core";

import { segments } from "../src/features/conversation/reply-segments.ts";

const think = (thinking: string, durationMs?: number, startedAt?: number, redacted?: boolean): AssistantContent => ({
	type: "thinking",
	thinking,
	...(durationMs === undefined ? {} : { durationMs }),
	...(startedAt === undefined ? {} : { startedAt }),
	...(redacted ? { redacted } : {}),
});
const say = (text: string): AssistantContent => ({ type: "text", text });
const call = (id: string): AssistantContent => ({ type: "toolCall", id, name: "read", arguments: {} });

test("说完话后连着的几段推理并成一段，空的那几块夹在中间也并进去", () => {
	const out = segments([think("", 684, 1), say("第三段已提取"), think("**A**", 3387, 100), think("", 798, 200), think("**B**", 2510, 300), say("")]);
	assert.equal(out.length, 4);
	assert.deepEqual(out[2], {
		kind: "block",
		block: { type: "thinking", thinking: "**A**\n\n**B**", redacted: false, startedAt: 100, durationMs: 3387 + 798 + 2510 },
		index: 2,
		last: 4,
	});
	// 开头那块空推理被一句话隔开，不并。
	assert.equal(out[0].kind === "block" && out[0].last, 0);
});

test("被话或调用隔开的推理各是一段", () => {
	const out = segments([think("a"), say("x"), think("b"), call("1"), think("c")]);
	assert.deepEqual(out.map((segment) => (segment.kind === "block" ? segment.block.type : "tools")), ["thinking", "text", "thinking", "tools", "thinking"]);
});

test("没有时长的推理并起来也说不出时长", () => {
	const [only] = segments([think("a"), think("b")]);
	assert.equal(only.kind === "block" && only.block.type === "thinking" ? only.block.durationMs : null, undefined);
});

test("看得见的推理里夹着被过滤掉的一段，给看得见的；全被过滤才说已隐藏", () => {
	const [mixed] = segments([think("a", 1, 1), think("", 1, 2, true)]);
	assert.ok(mixed.kind === "block" && mixed.block.type === "thinking" && mixed.block.redacted === false && mixed.block.thinking === "a");
	const [hidden] = segments([think("", 1, 1, true), think("", 1, 2)]);
	assert.ok(hidden.kind === "block" && hidden.block.type === "thinking" && hidden.block.redacted === true);
});

test("并的时候不改消息里原来的块", () => {
	const first = think("a", 1, 1);
	segments([first, think("b", 2, 2)]);
	assert.deepEqual(first, think("a", 1, 1));
});
