/**
 * 跑完的一段工具调用，折叠起来那一行说什么。
 *
 * 从前只报数：「执行命令 3 个」。模型几批不开口时这一行看不出在查什么，系统提示词就得逼它每批都说一句。
 * 现在说前两次调用各自的说明，其余报个数；说明都一样时退回计数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setActiveLocale } from "../src/i18n/translate.ts";
import { nameCalls } from "../src/features/conversation/call-words.ts";
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
		assert.equal(nameCalls(calls, said), "查看当前提交与工作区状态, 查询服务器现有镜像版本 and 1 more");
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
