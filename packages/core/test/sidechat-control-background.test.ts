/**
 * 侧边聊天的 `control_main` 看得见后台的活，`resume` 当场返回。
 *
 * 主会话这一轮收了尾、派出去的子代理还在后台跑的时候，`running` 是假的：从前 `pause` 据此回答「不需要
 * 暂停」，子代理接着跑、接着花钱；`status` 说「空闲」；`resume` 开一轮「接着做」，模型多半把那些活
 * 自己重做一遍。而 `resume` 等的是主会话整轮跑完，侧边聊天的这次工具调用就挂到那时候。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { controlMainTool } from "../src/runtime/side-chat/sidechat-controls.ts";
import type { MainSession } from "../src/runtime/side-chat/side-main.ts";
import type { ToolContext } from "../src/types.ts";

function fakeMain(state: { running: boolean; idle: boolean }) {
	const calls = { aborted: 0, prompts: 0 };
	const main = {
		get running() { return state.running; },
		get idle() { return state.idle; },
		taskQueue: [],
		interruptedTask: () => null,
		abort() { calls.aborted += 1; state.running = false; state.idle = true; },
		// 主会话这一轮永远跑不完：`resume` 要是等它，这条测试就挂住。
		prompt: () => { calls.prompts += 1; return new Promise(() => {}); },
	} as unknown as MainSession;
	return { main, calls };
}

const run = async (main: MainSession, action: string) => {
	const result = await controlMainTool(main).execute({ action }, {} as ToolContext);
	return result.content.map((part) => ("text" in part ? part.text : "")).join("");
};

test("这一轮收了尾、后台还在跑：pause 把它们一起停下，status 不说空闲", async () => {
	const { main, calls } = fakeMain({ running: false, idle: false });
	assert.match(await run(main, "status"), /后台还有它派出去的活没回来/);
	assert.match(await run(main, "pause"), /一并停下/);
	assert.equal(calls.aborted, 1, "和主窗口的停止键一样，后台的也停");
	assert.match(await run(main, "pause"), /不需要暂停/, "停完了才是真没东西可停");
});

test("后台还在跑时 resume 不开「接着做」那一轮", async () => {
	const { main, calls } = fakeMain({ running: false, idle: false });
	assert.match(await run(main, "resume"), /结果回来后它会自己接着做/);
	assert.equal(calls.prompts, 0);
});

test("resume 当场返回，不等主会话那一轮跑完", async () => {
	const { main, calls } = fakeMain({ running: false, idle: true });
	const answer = await Promise.race([run(main, "resume"), new Promise<string>((resolve) => setTimeout(() => resolve("还在等"), 500))]);
	assert.match(answer, /已经让主会话接着做了/);
	assert.equal(calls.prompts, 1);
});
