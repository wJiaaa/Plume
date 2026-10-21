/**
 * 跑完的一段工具调用，折叠起来那一行说什么。
 *
 * 从前只报数：「执行命令 3 个」。模型几批不开口时这一行看不出在查什么，系统提示词就得逼它每批都说一句。
 * 现在说前两次调用各自的说明，其余报个数；说明都一样时退回计数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setActiveLocale } from "../src/i18n/translate.ts";
import { describeOne, nameCalls } from "../src/features/conversation/call-words.ts";
import type { Call } from "../src/features/conversation/grouping.ts";

function bash(id: string, command = "true"): Call {
	return { block: { type: "toolCall", id, name: "bash", arguments: { command } }, stopReason: "toolUse" } as Call;
}

function poll(id: string, job: string): Call {
	return { block: { type: "toolCall", id, name: "bash_output", arguments: { id: job } }, stopReason: "toolUse" } as Call;
}

/** `nameCalls` 只读记录里的 `summary`，其余字段这里用不到。 */
function runs(summaries: Record<string, string>): Parameters<typeof nameCalls>[1] {
	return Object.fromEntries(Object.entries(summaries).map(([id, summary]) => [id, { summary }])) as never;
}

test("两次调用：两句说明都说出来", () => {
	const calls = [bash("a"), bash("b")];
	assert.equal(nameCalls(calls, runs({ a: "查看当前提交与工作区状态", b: "查询服务器现有镜像版本" })), "查看当前提交与工作区状态、查询服务器现有镜像版本");
});

test("多于两次：说前两句，再报一共几项", () => {
	const calls = [bash("a"), bash("b"), bash("c")];
	const said = runs({ a: "查看当前提交与工作区状态", b: "查询服务器现有镜像版本", c: "查询 Ops 控制面发布信息" });
	assert.equal(nameCalls(calls, said), "查看当前提交与工作区状态、查询服务器现有镜像版本 等 3 项");
	setActiveLocale("en");
	try {
		assert.equal(nameCalls(calls, said), "查看当前提交与工作区状态, 查询服务器现有镜像版本, 3 total");
	} finally {
		setActiveLocale("zh-CN");
	}
});

test("命令都没写说明：退回计数，不说成「执行命令、执行命令」", () => {
	assert.equal(nameCalls([bash("a"), bash("b"), bash("c")], runs({})), "执行命令 3 个");
});

test("有命令时，查它输出的那几次不算进去", () => {
	const calls = [bash("a"), poll("p1", "job"), poll("p2", "job"), bash("b")];
	assert.equal(nameCalls(calls, runs({ a: "构建 API 镜像", b: "构建 Web 镜像" })), "构建 API 镜像、构建 Web 镜像");
});

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
