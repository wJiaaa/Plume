/**
 * 输入框上方那一条列哪些会话（`features/conversation/handed-off.ts`），以及交计划那次调用在转录里怎么说。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { handedOffFrom } from "../src/features/conversation/handed-off.ts";
import { setActiveLocale } from "../src/i18n/translate.ts";
import { describeActivity } from "../src/lib/tool-kinds.ts";
import { summarizeToolCall } from "../src/lib/tool-summary.ts";

test("只列从这个会话交出去、此刻有话可说的：在跑、在等、跑完还没看", () => {
	const sessions = [
		{ id: "plan", title: "移除 Redisson", spawnedFrom: { sessionId: "main" } },
		{ id: "seen", title: "早就看过的", spawnedFrom: { sessionId: "main" } },
		{ id: "other", title: "别的会话开的", spawnedFrom: { sessionId: "elsewhere" } },
		{ id: "plain", title: "自己开的" },
		{ id: "review", title: "审阅", spawnedFrom: { sessionId: "main" } },
	];
	const activity = { plan: "running", other: "running", plain: "running", review: "done" } as const;
	assert.deepEqual(handedOffFrom(sessions, activity, "main"), [
		{ id: "plan", title: "移除 Redisson", activity: "running" },
		{ id: "review", title: "审阅", activity: "done" },
	]);
	assert.deepEqual(handedOffFrom(sessions, activity, null), []);
});

test("交计划那次调用：重开的会话和跑着的说法一样，不读作 submit_plan", () => {
	setActiveLocale("zh-CN");
	const plan = "# 移除 Redisson\n\n## 概要\n换成单实例锁。";
	assert.equal(summarizeToolCall("submit_plan", { plan }), "Plan: 移除 Redisson");
	assert.equal(describeActivity(summarizeToolCall("submit_plan", { plan })), "提交计划 移除 Redisson");
});
