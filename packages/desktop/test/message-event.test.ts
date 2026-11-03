import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";
import { drawnAt, keepDrawn, messageEvent } from "../src/store/message-event.ts";

const pending: Message = { role: "user", content: [{ type: "text", text: "相同的问题" }], timestamp: 1 };
const confirmed: Message = { ...pending, timestamp: 2 };

test("only the pending message's session may confirm it, regardless of text", () => {
	const state = { messages: [pending], pendingUserMessage: { sessionId: "a", message: pending } };
	const other = messageEvent(state, { type: "message_start", message: confirmed }, "b");
	assert.equal(other.pendingUserMessage, state.pendingUserMessage);
	assert.equal(other.messages[0], pending);
	const own = messageEvent(state, { type: "message_start", message: confirmed }, "a");
	assert.equal(own.pendingUserMessage, null);
	assert.deepEqual(own.messages, [confirmed]);
});

test("an uncreated draft is never a wildcard for an existing session", () => {
	const state = { messages: [pending], pendingUserMessage: { sessionId: null, message: pending } };
	const next = messageEvent(state, { type: "message_start", message: confirmed }, "a");
	assert.equal(next.pendingUserMessage, state.pendingUserMessage);
	assert.equal(next.messages[0], pending);
});

test("confirmation replaces the exact pending reference, preserving repeated prompts", () => {
	const earlier: Message = { ...pending, timestamp: 0 };
	const state = { messages: [earlier, pending], pendingUserMessage: { sessionId: "a", message: pending } };
	const next = messageEvent(state, { type: "message_end", message: confirmed }, "a");
	assert.deepEqual(next.messages, [earlier, confirmed]);
	assert.equal(next.pendingUserMessage, null);
});

test("the committed copy keeps the row the optimistic one was drawn in, through start and end", () => {
	const state = { messages: [pending], pendingUserMessage: { sessionId: "a", message: pending } };
	const started = messageEvent(state, { type: "message_start", message: confirmed }, "a");
	assert.equal(drawnAt(started.messages[0]), pending.timestamp);
	// message_end 送来的是另一个对象，按运行时的时间戳认领那一格；画在哪一行照旧。
	const ended = messageEvent(started, { type: "message_end", message: { ...confirmed } }, "a");
	assert.equal(ended.messages[0].timestamp, confirmed.timestamp);
	assert.equal(drawnAt(ended.messages[0]), pending.timestamp);
});

test("a transcript read back from disk keeps the objects on screen, and the rows of the ones that changed", () => {
	const state = { messages: [pending], pendingUserMessage: { sessionId: "a", message: pending } };
	const asked = messageEvent(state, { type: "message_start", message: confirmed }, "a").messages[0];
	const result: Message = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "旧" }], isError: false, timestamp: 3 };
	const screen = [asked, result];
	const read = structuredClone(screen);
	read[1] = { ...read[1], content: [{ type: "text", text: "盘上的才是准的" }] } as Message;
	const next = keepDrawn(screen, read);
	assert.equal(next[0], asked, "一样的沿用屏上那个对象");
	assert.equal(next[1], read[1], "变了的用读回来的");
	assert.equal(drawnAt(next[0]), pending.timestamp);
	// 变了内容的那一条也接着画在原来那一行。
	const moved = keepDrawn([asked], [{ ...structuredClone(asked), content: [{ type: "text", text: "改过" }] }]);
	assert.equal(drawnAt(moved[0]), pending.timestamp);
	const unchanged = [structuredClone(result)];
	assert.equal(keepDrawn([], unchanged), unchanged, "屏上没有的原样交回");
});

test("a message nobody drew earlier is keyed by its own timestamp", () => {
	const reply: Message = { role: "user", content: [{ type: "text", text: "另一句" }], timestamp: 5 };
	const next = messageEvent({ messages: [], pendingUserMessage: null }, { type: "message_start", message: reply }, "a");
	assert.equal(drawnAt(next.messages[0]), 5);
});
