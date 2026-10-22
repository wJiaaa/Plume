import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core/client-types";
import { ANSWER_CHARS, looksLikeAnswer } from "../src/running.ts";

type Block = Extract<Message, { role: "assistant" }>["content"][number];

const user: Message = { role: "user", content: [{ type: "text", text: "看看" }], timestamp: 1 };
const reply = (stopReason: "pending" | "stop" | "toolUse", ...content: Block[]): Message => ({
	role: "assistant", content, api: "anthropic-messages", provider: "p", model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason, timestamp: 2,
});
const text = (value: string, phase?: "commentary" | "final_answer"): Block => ({ type: "text", text: value, ...(phase ? { phase } : {}) });
const call: Block = { type: "toolCall", id: "c", name: "read", arguments: {} };

test("a one-line sentence is not taken for a conclusion: it may be the line before a tool call", () => {
	assert.equal(looksLikeAnswer([user, reply("pending", text("事件回路已经通了。最后补三处细节：命令怎么一路走到 runAgent、会话在磁盘上怎么存。"))]), false);
	// 中转网关把开场白标成 final_answer，这个标记不可信。
	assert.equal(looksLikeAnswer([user, reply("pending", text("先看看这个文件", "final_answer"))]), false);
});

test("a line break or more than a line's worth of text reads as the conclusion", () => {
	assert.equal(looksLikeAnswer([user, reply("pending", text("## 改好了\n\n手机端"))]), true);
	assert.equal(looksLikeAnswer([user, reply("pending", text("字".repeat(ANSWER_CHARS + 1)))]), true);
	assert.equal(looksLikeAnswer([user, reply("pending", text("字".repeat(ANSWER_CHARS)))]), false);
	// 首尾空白不算：文本块先开一个空的，模型也常在开头吐一个换行。
	assert.equal(looksLikeAnswer([user, reply("pending", text("\n先看看\n"))]), false);
});

test("whatever comes after the prose decides: a call, a think, or the end of the turn", () => {
	const long = text("结论\n\n第一段");
	assert.equal(looksLikeAnswer([user, reply("pending", long, call)]), false);
	assert.equal(looksLikeAnswer([user, reply("pending", long, { type: "thinking", thinking: "再想想" })]), false);
	assert.equal(looksLikeAnswer([user, reply("stop", long)]), false, "settled: the action row takes over, not this");
	assert.equal(looksLikeAnswer([user]), false);
});

test("text marked commentary is a preamble however long it is", () => {
	assert.equal(looksLikeAnswer([user, reply("pending", text("先查三处：\n- 入口\n- 存储\n- 手机", "commentary"))]), false);
});
