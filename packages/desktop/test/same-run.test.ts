/**
 * `sameRun`：一段工具调用什么时候不用重画。
 *
 * 转录每来一个字就重新渲染一次，上面那些跑完了的段要靠这条比较跳过；它答错的方向只能是「多画一次」，
 * 不能是「该画的没画」——调用跑完、子智能体的记录换了，段里没有别的东西会订阅到。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { StopReason, ToolCallContent } from "@plume/core";
import { sameRun, type Call } from "../src/features/conversation/grouping.ts";

function call(id: string): ToolCallContent {
	return { type: "toolCall", id, name: "read", arguments: { path: `/tmp/${id}.ts` } };
}

const CALLS: Call[] = [{ block: call("a"), stopReason: "toolUse" }];

test("没有任何变化的段跳过重画", () => {
	assert.equal(sameRun({ calls: CALLS }, { calls: CALLS }), true);
	assert.equal(sameRun({ calls: CALLS }, { calls: [{ ...CALLS[0] }] }), true, "同样的调用换了一个数组也算没变");
});

test("多了一个调用要重画", () => {
	assert.equal(sameRun({ calls: CALLS }, { calls: [...CALLS, { block: call("b"), stopReason: "toolUse" as StopReason }] }), false);
});

test("段里有调用跑完了要重画", () => {
	assert.equal(sameRun({ calls: CALLS }, { calls: [{ block: call("a"), stopReason: "stop" as StopReason }] }), false);
});

test("子智能体注入的记录换了一份要重画", () => {
	// 段里没有东西订阅它们，换了一份新的是调用跑完的唯一信号。
	assert.equal(sameRun({ calls: CALLS, runs: {} }, { calls: CALLS, runs: {} }), false);
});
