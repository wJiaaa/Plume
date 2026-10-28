/**
 * 交出去的会话在主会话那一行上说的「那边在做什么」：最近开始的那一步，读成转录里的说法，一轮结束就清掉。
 * 规则在 `store/session-doing.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { setActiveLocale } from "../src/i18n/translate.ts";
import { describeCall } from "../src/lib/tool-kinds.ts";
import { noteSessionDoing, useSessionDoing } from "../src/store/session-doing.ts";

test("最近开始的那一步，和转录里同一句；一轮结束就清掉，不留已经不在做的事", () => {
	setActiveLocale("zh-CN");
	noteSessionDoing("child", { type: "tool_start", toolCallId: "a", toolName: "read", args: { path: "pom.xml" }, summary: "Read pom.xml" });
	assert.equal(useSessionDoing.getState().bySession.child, describeCall("read", "Read pom.xml"));
	noteSessionDoing("child", { type: "tool_start", toolCallId: "b", toolName: "bash", args: { command: "mvn test" }, summary: "运行单元测试" });
	assert.equal(useSessionDoing.getState().bySession.child, "运行单元测试", "命令的描述是人写的话，原样留着");
	noteSessionDoing("other", { type: "turn_start", turn: 1 });
	assert.equal(useSessionDoing.getState().bySession.other, undefined);
	noteSessionDoing("child", { type: "agent_end", reason: "done" });
	assert.equal(useSessionDoing.getState().bySession.child, undefined);
});
