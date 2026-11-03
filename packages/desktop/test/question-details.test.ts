import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationTime, questionsIn, questionWindow, timeSeparators, QUESTION_LIMIT } from "../src/features/conversation/question-navigation.ts";
import type { Message } from "@plume/core";

const user = (timestamp: number, text = "same"): Message => ({ role: "user", timestamp, content: [{ type: "text", text }] });

test("navigation keeps a bounded, complete neighbourhood at every position, including both ends", () => {
	for (const total of [0, 1, 5, 15, 16, 120, 1000]) {
		for (let position = 0; position < Math.max(1, total); position++) {
			const { start, end } = questionWindow(total, position);
			assert.equal(end - start, Math.min(QUESTION_LIMIT, total));
			assert.ok(start >= 0 && end <= total);
			if (total) assert.ok(start <= position && end > position);
		}
	}
	assert.deepEqual(questionWindow(100, 0), { start: 0, end: 15 });
	assert.deepEqual(questionWindow(100, 99), { start: 85, end: 100 });
	assert.deepEqual(questionWindow(100, 40), { start: 33, end: 48 });
});

test("repeated text and image-only questions retain distinct navigation targets", () => {
	const questions = questionsIn([user(0), { role: "user", timestamp: 1, synthetic: true, content: [{ type: "text", text: "runtime" }] }, user(2), { role: "user", timestamp: 3, content: [] }]);
	assert.deepEqual(questions.map((q) => q.index), [0, 2, 3]);
	assert.equal(questions[2].text, "图片消息");
});

test("time labels separate pauses and calendar days without dividing continuous activity", () => {
	const day = new Date(2026, 8, 6, 23, 50).getTime();
	assert.deepEqual([...timeSeparators([user(day), user(day + 60_000), user(day + 11 * 60_000), user(day + 45 * 60_000)])], [0, 2, 3]);
	assert.match(conversationTime(day, day), /^今天 /);
	assert.match(conversationTime(day, day + 86_400_000), /^昨天 /);
	assert.match(conversationTime(day, day + 2 * 86_400_000), /^9月6日 /);
});

test("问题导航读的是人打的那句话，不是写给模型的引用和附件正文", () => {
	const [withRefs, oldWithFile] = questionsIn([
		{ role: "user", timestamp: 0, displayText: "看看这个会话", content: [{ type: "text", text: "看看这个会话\n\n[Referenced context]\n- \"x\": read session://x" }] },
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "\n\n### Attached file: a.md\n\n正文" }, { type: "text", text: "总结一下" }] },
	]);
	assert.equal(withRefs.text, "看看这个会话");
	assert.equal(oldWithFile.text, "总结一下");
});
