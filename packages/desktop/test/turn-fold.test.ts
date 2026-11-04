/**
 * 跑完的一轮只留回答：收起哪几行。
 *
 * 判错边界不报错，只是屏幕上不对：把回答收进去，人只看到一行「执行命令 12 个」；把出错的那一行收进去，
 * 出过事的一轮看上去和顺利跑完的一样；把页面收进去，给人看的结果被当成了过程。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";

import type { Run } from "../src/features/conversation/grouping.ts";
import type { Hiccup } from "../src/lib/hiccup.ts";
import { turnBlocks } from "../src/features/conversation/turn-blocks.ts";
import { turnFold } from "../src/features/conversation/turn-fold.ts";

const ask = (text: string, index: number): Run => ({
	kind: "message",
	message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } as Message,
	index,
	upTo: 1,
});

const say = (text: string, index: number, stopReason = "end"): Run => ({
	kind: "message",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason } as Message,
	index,
	upTo: 1,
});

let id = 0;
const work = (n: number, name = "bash"): Run => ({
	kind: "tools",
	calls: Array.from({ length: n }, () => ({ block: { type: "toolCall", id: `c${id++}`, name, arguments: { command: "make" } }, stopReason: "toolUse" })) as Run extends { kind: "tools"; calls: infer C } ? C : never,
});

const page = (): Run => ({ ...(work(1, "preview") as Extract<Run, { kind: "tools" }>), shown: true });
const hiccup = (outcome: Hiccup["outcome"]): Run => ({ kind: "hiccup", hiccup: { id: `h${id++}`, outcome } as Hiccup });

/** 这一轮里每一行收没收：`fold` 收进去，`pin` 在收起范围里但留在外面，`-` 不收。 */
function shape(list: Run[]) {
	const block = turnBlocks(list).find((one) => one.kind === "work");
	assert.ok(block);
	const fold = turnFold(block.items);
	if (!fold) return null;
	return block.items.map((item, at) => (at < fold.start || at >= fold.answer ? "-" : fold.pinned.has(item.key) ? "pin" : "fold"));
}

test("回答之前的过程和中途说的话一起收起来，回答留在外面", () => {
	const list = [ask("部署一下", 0), say("先推送。", 1), work(2), say("推送完成，开始构建。", 2), work(3), say("部署完成。", 3)];
	assert.deepEqual(shape(list), ["fold", "fold", "fold", "fold", "-"]);
	const block = turnBlocks(list)[1];
	assert.equal(turnFold(block.items)?.calls.length, 5, "那一行说的是收起来的全部调用");
});

test("回答后面还有活，那一段留在回答后面", () => {
	assert.deepEqual(shape([ask("跑一下", 0), work(1), say("好了。", 1), work(1)]), ["fold", "-", "-"]);
});

test("出错的回复和它前面的留在外面，只收它后面那一截", () => {
	const failed: Run = { kind: "message", message: { role: "assistant", content: [], stopReason: "error" } as Message, index: 2, upTo: 0 };
	assert.deepEqual(shape([ask("跑一下", 0), work(1), failed, work(1), say("接着说。", 3), work(1), say("好了。", 5)]), ["-", "-", "fold", "fold", "fold", "-"]);
});

test("还在等、放弃了、被停下的断线留在外面；恢复了的收进去", () => {
	assert.deepEqual(shape([ask("跑", 0), work(1), hiccup("gave_up"), work(1), say("好了。", 1)]), ["-", "-", "fold", "-"]);
	assert.deepEqual(shape([ask("跑", 0), work(1), hiccup("recovered"), work(1), say("好了。", 1)]), ["fold", "fold", "fold", "-"]);
});

test("页面是给人看的结果：在收起范围里，但留在外面", () => {
	assert.deepEqual(shape([ask("做个页面", 0), work(2), page(), say("页面在上面。", 1)]), ["fold", "pin", "-"]);
});

test("没有回答、或回答前面一段活都没有的一轮，不收", () => {
	assert.equal(shape([ask("跑一下", 0), work(2)]), null, "停在半路，收起来就什么都看不到了");
	assert.equal(shape([ask("说两句", 0), say("一。", 1), say("二。", 2)]), null);
});
