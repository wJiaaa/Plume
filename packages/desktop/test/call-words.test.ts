/** 一次调用在行上怎么说（`describeOne`），一段活那一行怎么说（`describeCalls`）。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCalls, describeOne } from "../src/features/conversation/call-words.ts";
import type { Call } from "../src/features/conversation/grouping.ts";

function bash(id: string, command = "true"): Call {
	return { block: { type: "toolCall", id, name: "bash", arguments: { command } }, stopReason: "toolUse" } as Call;
}

test("还没开跑的命令：说明已经写出来就用它，不等 tool_start 的摘要", () => {
	// 写完了、在等整条回复结束：还没有记录，`summary` 是 undefined。
	const queued = { type: "toolCall", id: "q", name: "bash", arguments: { command: "cp a b", description: "复制界面要用的图标" } } as Call["block"];
	assert.equal(describeOne(queued, undefined), "复制界面要用的图标");
	assert.equal(describeOne(bash("n").block, undefined), "执行命令");
});

function todos(list: unknown): Call["block"] {
	return { type: "toolCall", id: "t", name: "todo_write", arguments: { todos: list } } as Call["block"];
}

test("更新清单：说进度和正在做的那一项，不用 core 那句英文摘要", () => {
	const list = [
		{ content: "读现有实现", status: "completed" },
		{ content: "加同步接口", status: "in_progress", activeForm: "正在加同步接口" },
		{ content: "补测试", status: "pending" },
	];
	assert.equal(describeOne(todos(list), "正在加同步接口"), "更新清单 1/3 · 加同步接口");
	assert.equal(describeOne(todos(list.map((t) => ({ ...t, status: "completed" }))), "Update task list"), "更新清单 3/3");
	// 参数还在流进来，清单还没到
	assert.equal(describeOne(todos(undefined), "Update task list"), "更新清单");
});

test("清单并在一段活里时那一行不点名它；只有清单时照旧说更新清单", () => {
	const call = (block: Call["block"]) => ({ block, stopReason: "toolUse" }) as Call;
	assert.equal(describeCalls([call(todos([])), bash("a"), call(todos([]))]), "执行命令");
	assert.equal(describeCalls([call(todos([])), call(todos([]))]), "更新清单 2 个");
});
