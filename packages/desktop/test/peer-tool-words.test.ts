/**
 * 会话之间那四个工具在转录里怎么说。
 *
 * 跑着时 core 给的摘要是 `Notify 名字 [ref]`，重开的会话里只剩工具名；两条路从前分别画成英文摘要和
 * 光秃秃的 `notify_session`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setActiveLocale } from "../src/i18n/translate.ts";
import { describeOne } from "../src/features/conversation/call-words.ts";
import { summarizeToolCall } from "../src/lib/tool-summary.ts";

const call = (name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id: "c", name, arguments: args });

test("跑着的和重开的说同一句：动作加对方的名字，不带 ref", () => {
	setActiveLocale("zh-CN");
	const notify = call("notify_session", { to: "测试用例归档改为删除 [a1b2c3]", message: "x" });
	assert.equal(describeOne(notify, "Notify 测试用例归档改为删除 [a1b2c3]"), "通知会话 测试用例归档改为删除");
	assert.equal(describeOne(notify, summarizeToolCall("notify_session", notify.arguments)), "通知会话 测试用例归档改为删除");
	assert.equal(describeOne(call("wait_for_session", { to: "修登录" }), "Wait for 修登录"), "等待会话 修登录");
	assert.equal(describeOne(call("ask_session", { to: "修登录", message: "?" }), "Ask 修登录"), "询问会话 修登录");
	assert.equal(describeOne(call("list_sessions", {}), "List sessions"), "查看在跑的会话");
});

test("只写了 ref 的照原样说；别的工具参数里的 to 不当成对象", () => {
	setActiveLocale("zh-CN");
	assert.equal(describeOne(call("wait_for_session", { to: "[a1b2c3]" }), "Wait for [a1b2c3]"), "等待会话 [a1b2c3]");
	assert.equal(describeOne(call("mcp__mail__send", { to: "alice@example.com" }), "mail: send"), "mail: send");
});

test("英文界面", () => {
	setActiveLocale("en");
	try {
		assert.equal(describeOne(call("notify_session", { to: "Fix login [a1b2c3]" }), "Notify Fix login [a1b2c3]"), "Notified session Fix login");
	} finally {
		setActiveLocale("zh-CN");
	}
});
