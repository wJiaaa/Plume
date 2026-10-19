/**
 * 下一步建议的写法：认哪些、不认哪些，给人看时去掉，提示词只给有输入框可填的端。见 `followups.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { followups, matchFollowup, withoutFollowups } from "../src/followups.ts";
import { buildPromptContext } from "../src/prompt/system.ts";
import type { Tool } from "../src/types.ts";

test("写完了的标记：要填的那句、结束位置", () => {
	const source = "好了 :followup[把登录页的 e2e 跑一遍] 后面";
	assert.deepEqual(matchFollowup(source, source.indexOf(":")), { prompt: "把登录页的 e2e 跑一遍", end: source.indexOf(" 后面") });
	assert.equal(matchFollowup(":followup[数组 a[0\\] 越界了，修一下]", 0)?.prompt, "数组 a[0] 越界了，修一下", "方括号能转义");
});

test("没写完、跨了行、空的都不算，照原样当字", () => {
	for (const source of [":followup[跑测试", ":followup[跑\n测试]", ":followup[  ]", "::followup[跑测试]", ":followups[跑测试]"]) {
		assert.equal(matchFollowup(source, 0), null, source);
	}
});

test("代码块和行内代码里的是在讲这个写法，不算", () => {
	const text = ["写法是 `:followup[a]`。", "```md", ":followup[b]", "```", ":followup[真的这一句]"].join("\n");
	assert.deepEqual(followups(text).map((item) => item.prompt), ["真的这一句"]);
});

test("去掉标记：独占的那一行整行拿掉，不留空行；别的原样", () => {
	assert.equal(withoutFollowups("修好了。\n\n:followup[跑一下 e2e]\n"), "修好了。");
	assert.equal(withoutFollowups("修好了。 :followup[跑一下 e2e]"), "修好了。");
	assert.equal(withoutFollowups("硬换行  \n修好了。\n\n:followup[x]"), "硬换行  \n修好了。", "别处行尾的空格不动");
	assert.equal(withoutFollowups("`:followup[x]` 是写法"), "`:followup[x]` 是写法");
	assert.equal(withoutFollowups("没有标记\n\n"), "没有标记\n\n");
});

test("提示词：开着、又是桌面端的会话时才有这一段", async () => {
	const base = { cwd: "/fixture", tools: [{ name: "preview" } as Tool], skills: [], projectInstructions: [], platform: "darwin", modelName: "Fixture", isGitRepo: false };
	const has = (prompt: { sections: { source: string }[] }) => prompt.sections.some((part) => part.source === "followups");
	assert.ok(has(await buildPromptContext({ ...base, followups: true })));
	assert.ok(!has(await buildPromptContext(base)), "设置关着");
	assert.ok(!has(await buildPromptContext({ ...base, tools: [], followups: true })), "命令行没有输入框");
	assert.ok(!has(await buildPromptContext({ ...base, interfaceBlocks: false, followups: true })));
});
