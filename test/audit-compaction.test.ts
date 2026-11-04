/**
 * 第 13 节「用户把话再说一遍」：压缩后提到之前说过，或者折叠掉的原话又出现了，才算；
 * 保留在尾部、模型还看得见的那些不算，「继续」这种短话也不算。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { afterCompaction, restates, type AuditStream } from "../scripts/audit-compaction.ts";
import { emptyUsage, type Message } from "../packages/core/src/types.ts";

const user = (text: string, synthetic = false): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...(synthetic ? { synthetic: true } : {}) });
const said = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "p", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp: 1 });

const stream = (messages: Message[], at: number, kept: number): AuditStream => ({ messages, calls: [], boundaries: [{ at, kept }], resultChars: () => 0 });

test("a folded instruction said again after the boundary counts; one still in the kept tail does not", () => {
	const messages = [
		user("改完以后不要推送到远端分支，等我先看过"),
		said("好的"),
		user("只改 packages/core 里面的代码，桌面端不要动"),
		said("明白"),
		// 边界：之前 4 条，保留最后 2 条（第 3、4 条）。
		user("记得：改完以后不要推送到远端分支，等我先看过"),
		user("只改 packages/core 里面的代码，桌面端不要碰"),
		user("我之前说过要先跑测试"),
		user("继续"),
		user("<env>今天是 2026-11-04</env>", true),
	];
	const result = afterCompaction([stream(messages, 4, 2)]);
	assert.equal(result.userAfter, 4, "synthetic messages are not the user speaking");
	assert.equal(result.repeatedAfter, 2, "the folded one restated, and the explicit reference back");
});

test("restating needs real overlap and some length", () => {
	assert.ok(restates("不要推送到远端分支，等我先看过", "改完以后不要推送到远端分支，等我先看过"));
	assert.ok(!restates("继续", "继续"), "short replies repeat by nature");
	assert.ok(!restates("帮我看一下登录页为什么白屏了", "改完以后不要推送到远端分支，等我先看过"));
});
