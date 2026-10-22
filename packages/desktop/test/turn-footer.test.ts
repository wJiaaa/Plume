/**
 * 一轮的页脚（时间、耗时、tok/s、复制）落在哪一条回复下面。
 *
 * 会话 d372d301：一段正文写完，清单还有一项「正在做」，运行时追问了一句（core 的 `openPlanNote`，
 * 「（自动提示）」开头），模型接着干了两分半钟。页脚从前只认「（自动继续）」这一种续跑，于是贴在了
 * 那段正文底下——一轮还在跑，先结了账。这里守的是：页脚只给一轮的最后一句，不管插进来的是哪句话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantContent, AssistantMessage, Message, StopReason, ToolCallContent } from "@plume/core";
import { emptyUsage } from "@plume/core";

import { runs, type Run } from "../src/features/conversation/grouping.ts";

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function injected(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1, synthetic: true };
}

const PLAN_ASK = "（自动提示）任务清单里还有 1 项没勾";

function assistant(content: AssistantContent[], stopReason: StopReason): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "p", model: "m", usage: emptyUsage(), stopReason, timestamp: 1 };
}

function text(value: string): AssistantContent {
	return { type: "text", text: value };
}

function call(id: string, name = "read"): ToolCallContent {
	return { type: "toolCall", id, name, arguments: {} };
}

function result(id: string, toolName = "read"): Message {
	return { role: "toolResult", toolCallId: id, toolName, content: [], isError: false, timestamp: 2 };
}

/** 带页脚的那些行，记成消息下标。 */
function closing(rows: Run[]): number[] {
	return rows.flatMap((row) => (row.kind === "message" && row.closes ? [row.index] : []));
}

function newest(rows: Run[]): number[] {
	return rows.flatMap((row) => (row.kind === "message" && row.newest ? [row.index] : []));
}

test("清单追问之后接着干活又说了话，页脚只在后面那段", () => {
	const messages = [
		user("改一下"),
		assistant([text("改好了，还差验证")], "stop"),
		injected(PLAN_ASK),
		assistant([text("接着补测试"), call("a")], "toolUse"),
		result("a"),
		assistant([text("测试也补上了")], "stop"),
	];
	assert.deepEqual(closing(runs(messages)), [5]);
});

test("清单追问之后只勾了清单，页脚留在原来那段回答上", () => {
	const messages = [user("改一下"), assistant([text("改好了")], "stop"), injected(PLAN_ASK), assistant([call("t", "todo_write")], "toolUse"), result("t", "todo_write")];
	assert.deepEqual(closing(runs(messages)), [1]);
});

test("截断后自动续写，页脚在续写那段", () => {
	const messages = [user("写一段"), assistant([text("前半段")], "length"), injected("（自动继续）上一条回复达到了输出长度上限"), assistant([text("后半段")], "stop")];
	assert.deepEqual(closing(runs(messages)), [3]);
});

test("说完一句接着调工具的回复不是一轮的结尾；每轮各有自己的一个页脚", () => {
	const messages = [
		user("一"),
		assistant([text("先看看"), call("a")], "toolUse"),
		result("a"),
		assistant([text("看完了")], "stop"),
		user("二"),
		assistant([text("好")], "stop"),
	];
	assert.deepEqual(closing(runs(messages)), [3, 5]);
});

test("运行时插的话不开新的一轮，人说的话才开", () => {
	const messages = [user("改一下"), assistant([text("改好了")], "stop"), injected(PLAN_ASK), assistant([text("接着")], "pending")];
	// 还在跑：前面那段眼下是这一轮的最后一句，但它属于最新一轮（newest），调用方据此先不画页脚。
	assert.deepEqual(closing(runs(messages)), [1]);
	assert.deepEqual(newest(runs(messages)), [1]);
	// 人又开了口：那一轮定了，新的一轮还没有说完的话。
	assert.deepEqual(newest(runs([...messages, user("再改一处")])), []);
});

function delivered(id: string, steered: boolean): Message {
	return {
		role: "user", content: [{ type: "text", text: `<report>${id}</report>` }], timestamp: 1, synthetic: true,
		delivery: [{ id, agent: "review", description: id, status: "done" }],
		...(steered ? { steered: true as const } : {}),
	};
}

function pausing(rows: Run[]): number[] {
	return rows.flatMap((row) => (row.kind === "message" && row.pauses ? [row.index] : []));
}

/*
 * 会话 eb8d33e0：「API 评审支持……」写完时下一路子代理的结果正好到了，被插进这一轮。那句话说完了，
 * 底下却没有时间和复制——一轮还没收尾——而它和下一行题注之间那段空白让人去悬停，什么也没有。
 */
test("说完一句时插进来的送达：那句有自己的页脚，整轮的页脚仍在最后", () => {
	const rows = runs([
		user("分头查"),
		assistant([text("派出去了")], "stop"),
		delivered("a", false),
		assistant([text("A 的结论")], "stop"),
		delivered("b", true),
		assistant([text("B 的结论")], "stop"),
	]);
	assert.deepEqual(pausing(rows), [3]);
	assert.deepEqual(closing(rows), [1, 5]);
});

test("干活时插进来的送达：上面是工具，没有哪句被当成一段的结尾", () => {
	const rows = runs([
		user("分头查"),
		assistant([text("先读一下"), call("a")], "toolUse"),
		result("a"),
		delivered("b", true),
		assistant([text("B 的结论")], "stop"),
	]);
	assert.deepEqual(pausing(rows), []);
	assert.deepEqual(closing(rows), [4]);
});

/** 每一行是什么，按画出来的顺序：话写成 `话:下标`，页脚那一行写成 `页脚:下标`。 */
function shape(rows: Run[]): string[] {
	return rows.map((row) => {
		if (row.kind === "tools") return `活:${row.calls.map((c) => c.block.id).join(",")}`;
		if (row.kind !== "message") return row.kind;
		if (row.trailer) return `页脚:${row.index}`;
		return `${row.message.role === "user" ? "人" : "话"}:${row.index}${row.closes ? "+页脚" : ""}`;
	});
}

/*
 * 会话 ecd15848：说完「整合检查时发现……」接着发了三个调用，人按「现在就发」插了一句，这条回复成了
 * aborted、三个调用没执行。页脚贴在那句话底下，三行红叉落在页脚下面，看上去不属于上一轮。
 */
test("被停下的回复末尾挂着调用：页脚接在那几行后面，不夹在话和它的调用中间", () => {
	const messages = [
		user("发版"),
		assistant([text("整合检查时发现另一处会话在改"), call("a", "list_sessions"), call("b")], "aborted"),
		{ ...result("a", "list_sessions"), isError: true },
		{ ...result("b"), isError: true },
		{ ...user("先不要发布"), interrupting: true as const },
		assistant([text("已暂停")], "stop"),
	];
	const rows = runs(messages, [{ at: 4, id: "c", name: "compact", status: "done" } as never]);
	// 命令标记站在两轮之间：页脚在它前面，不然就被分到了下一轮。
	assert.deepEqual(shape(rows), ["人:0", "话:1", "活:a,b", "页脚:1", "command", "人:4", "话:5+页脚"]);
	assert.deepEqual(closing(rows), [1, 5]);
});

test("收尾那句后面没有活：页脚照旧挂在话底下，不另起一行", () => {
	const rows = runs([user("一"), assistant([text("先看看"), call("a")], "toolUse"), result("a"), assistant([text("看完了")], "aborted"), user("二")]);
	assert.deepEqual(shape(rows), ["人:0", "话:1", "活:a", "话:3+页脚", "人:4"]);
});

test("继续之后还在跑：页脚不先拆出来，等这一轮收了尾再说", () => {
	const messages = [
		user("发版"),
		assistant([text("先检查一下"), call("a")], "aborted"),
		{ ...result("a"), isError: true },
		user("继续，从暂停的地方接着做。"),
		assistant([call("b")], "toolUse"),
	];
	assert.deepEqual(shape(runs(messages)), ["人:0", "话:1+页脚", "活:a", "人:3", "活:b"]);
});

test("最后一轮的页脚单独成行时，newest 标在那一行上，不在话底下", () => {
	const messages = [user("发版"), assistant([text("先检查"), call("a")], "aborted"), { ...result("a"), isError: true }];
	const rows = runs(messages);
	assert.deepEqual(shape(rows), ["人:0", "话:1", "活:a", "页脚:1"]);
	assert.deepEqual(rows.flatMap((row) => (row.kind === "message" && row.newest ? [row.trailer === true] : [])), [true]);
});
