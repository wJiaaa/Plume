import assert from "node:assert/strict";
import { test } from "node:test";
import { taskTip } from "../src/features/sidechat/task-tip.ts";

test("短指令原样放进提示，状态在最后", () => {
	assert.equal(taskTip("跑一遍测试", "排队中"), "跑一遍测试\n\n排队中");
});

test("几十行的计划只留前六行，截掉的地方有省略号，状态行还在", () => {
	const plan = Array.from({ length: 40 }, (_, i) => `第 ${i} 步`).join("\n");
	const tip = taskTip(plan, "主会话执行中");
	assert.equal(tip, "第 0 步\n第 1 步\n第 2 步\n第 3 步\n第 4 步\n第 5 步…\n\n主会话执行中");
});

test("空行不占提示里的行数", () => {
	assert.equal(taskTip("# 计划\n\n\n## 第一步\n\n做这个", "已完成"), "# 计划\n## 第一步\n做这个\n\n已完成");
});

test("一整段不换行的长文本按字数截", () => {
	const tip = taskTip("长".repeat(500), "已完成");
	assert.equal(tip, `${"长".repeat(160)}…\n\n已完成`);
});

test("按字符截，不把 emoji 劈开", () => {
	const tip = taskTip("😀".repeat(200), "已完成");
	assert.equal(Array.from(tip.split("\n")[0]!).length, 161);
	assert.ok(!tip.includes("�") && tip.startsWith("😀"));
	assert.ok(tip.split("\n")[0]!.endsWith("😀…"));
});
