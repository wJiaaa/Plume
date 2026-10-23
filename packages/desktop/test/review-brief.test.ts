/**
 * 交给审阅会话的交接单：必填字段逐项卡长度、一次点名缺哪几项；用户原话由运行时按时间顺序原样附上，
 * 合成的不算，超长时留最早一条和最近几条；第一条消息各节齐全、顺序照任务说明。规则在 `electron/session/review-brief.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_SESSION_OPENING, type Message } from "@plume/core";
import { reviewHandoff, reviewPrompt, userWords } from "../electron/session/review-brief.ts";
import type { ReviewHandoff, ReviewSessionDetails } from "../shared/session-suggestion.ts";

const ARGS = {
	background: "用户说登录只能用密码，公司要求接入 OAuth，让我给登录加一条 OAuth 回调路由。",
	decisions: "用户说「不要动 session.ts」；「回调地址读配置，不要写死」。",
	implementation: "在 src/auth.ts 加了回调路由，复用现有的写会话逻辑；回调地址从配置读，和计划一致。",
	files: [{ path: "src/auth.ts", change: "加 OAuth 回调路由和失败分支" }],
	out_of_scope: "手机端不动，用户说过这次只管桌面。",
	unverified: "回调失败的那个分支没有测试，也没在真浏览器里跑过。",
	focus: "回调里读配置失败时的处理。",
};
const said = (text: string, over: Record<string, unknown> = {}) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...over }) as unknown as Message;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as unknown as Message;

test("交接单齐全时原样收下（去掉首尾空白），可选项没写就没有", () => {
	const handoff = reviewHandoff({ ...ARGS, background: `\n${ARGS.background}  ` }, false);
	assert.deepEqual(handoff, {
		background: ARGS.background, decisions: ARGS.decisions, implementation: ARGS.implementation, files: ARGS.files,
		outOfScope: ARGS.out_of_scope, unverified: ARGS.unverified, focus: ARGS.focus,
	} satisfies ReviewHandoff);
	const bare = reviewHandoff({ ...ARGS, out_of_scope: undefined, focus: "  " }, false) as ReviewHandoff;
	assert.equal(bare.outOfScope, undefined);
	assert.equal(bare.focus, undefined);
	// 明写的「没有」是合格的。
	assert.ok(!("error" in (reviewHandoff({ ...ARGS, decisions: "用户没有额外约束", unverified: "没有已知未验证的地方" }, false) ?? {})));
});

test("缺项、太短一次全点名，说清楚要多长；交一句话打发不过去", () => {
	const cases: [Record<string, unknown>, RegExp[]][] = [
		[{}, [/background \(missing\)/, /decisions \(missing\)/, /implementation \(missing\)/, /files \(missing/, /unverified \(missing\)/]],
		[{ ...ARGS, background: "修个 bug" }, [/background \(6 characters, at least 40\)/]],
		[{ ...ARGS, decisions: "无" }, [/decisions \(1 characters, at least 8\)/]],
		[{ ...ARGS, unverified: "没有" }, [/unverified \(2 characters, at least 6\)/]],
		[{ ...ARGS, implementation: "   " }, [/implementation \(missing\)/]],
		[{ ...ARGS, files: [] }, [/files \(missing/]],
		[{ ...ARGS, files: [{ path: "src/a.ts" }, { change: "改了很多东西" }] }, [/files\[0\]\.change for src\/a\.ts \(missing\)/, /files\[1\]\.path \(missing\)/]],
	];
	for (const [args, messages] of cases) {
		const checked = reviewHandoff(args, false);
		assert.ok(checked && "error" in checked, JSON.stringify(args).slice(0, 80));
		assert.match(checked.error, /^The hand-off is incomplete — missing or too short: /);
		for (const message of messages) assert.match(checked.error, message);
		assert.match(checked.error, /quote the person's own words/, "告诉它怎么补");
	}
	// 只缺一项时只点那一项。
	const one = reviewHandoff({ ...ARGS, unverified: undefined }, false) as { error: string };
	assert.match(one.error, /missing or too short: unverified \(missing\)\. /);
	// 类型不对、太长是另一种错：直接说。
	assert.match((reviewHandoff({ ...ARGS, background: 7 }, false) as { error: string }).error, /^background must be text/);
	assert.match((reviewHandoff({ ...ARGS, files: "src/a.ts" }, false) as { error: string }).error, /^files must be a list/);
	assert.match((reviewHandoff({ ...ARGS, implementation: "长".repeat(8_001) }, false) as { error: string }).error, /implementation is 8001 characters; keep it to 8000/);
});

test("审 PR 一项不填是对的；填了一项就按全套校验", () => {
	assert.equal(reviewHandoff({}, true), undefined);
	const half = reviewHandoff({ background: ARGS.background }, true) as { error: string };
	assert.match(half.error, /decisions \(missing\)/);
});

test("用户原话：按时间顺序、原文；合成的、助手的不算；点名技能的写回 /名字", () => {
	const messages = [
		said("把登录改成 OAuth"),
		reply("好的"),
		said("<session_result …>报告</session_result>", { synthetic: true }),
		said("不要动 session.ts", { displayText: "不要动 session.ts" }),
		said("Use the `pdf` skill.\n\n看一下", { skillRef: { name: "pdf" }, displayText: "看一下" }),
		said("# Code review\n\n…\n\nArguments: --effort medium", { displayText: "/review --effort medium" }),
		said("", {}),
	];
	assert.deepEqual(userWords(messages), {
		words: [
			{ n: 1, text: "把登录改成 OAuth" },
			{ n: 2, text: "不要动 session.ts" },
			{ n: 3, text: "/pdf 看一下" },
			{ n: 4, text: "/review --effort medium" },
		],
		omitted: 0,
	});
});

test("用户原话超过一万二千字：留最早一条和放得下的最近几条，注明中间省略了几条；单条先截到三千字", () => {
	const long = (tag: string) => `${tag}${"字".repeat(2_995)}`;
	const messages = ["最初的需求", ...Array.from({ length: 9 }, (_, at) => long(`第${at + 2}条`))].map((text) => said(text));
	const { words, omitted } = userWords(messages);
	assert.equal(words[0].n, 1, "最早一条总在");
	assert.equal(words[0].text, "最初的需求");
	assert.deepEqual(words.slice(1).map((one) => one.n), [7, 8, 9, 10], "最近几条，按时间顺序");
	assert.equal(omitted, 5);
	assert.ok(words.reduce((sum, one) => sum + [...one.text].length, 0) <= 12_000);

	const huge = userWords([said("开头"), said("日志".repeat(5_000)), said("最后一句")]);
	assert.equal([...huge.words[1].text].length, 3_001, "三千字加一个省略号");
	assert.equal(huge.omitted, 0);
});

test("第一条消息照任务说明的顺序排，各节都在；原话夹着省略说明", () => {
	const details: ReviewSessionDetails = { kind: "review_session", title: "审阅 · 登录", subject: "登录", effort: "high", handoff: reviewHandoff(ARGS, false) as ReviewHandoff };
	const many = [said("最初的需求"), ...Array.from({ length: 9 }, (_, at) => said(`第${at + 2}条${"字".repeat(2_995)}`))];
	const prompt = reviewPrompt(details, "# 计划\n\n改登录", many, "登录改走 OAuth", "登录改走 OAuth [a1b2c3]");
	assert.ok(prompt.startsWith(`${REVIEW_SESSION_OPENING}\n\n## 你是谁、做什么\n\n你是审阅会话：「登录改走 OAuth」`));
	const order = [
		"## 你是谁、做什么", "## 背景", "## 用户的决定与原话", "### 原会话整理的决定与约束", "### 用户原话", "## 计划原文",
		"## 实现说明（作者自述）", "## 改动文件", "## 不做的事", "## 未验证的地方", "## 审阅重点", "## 目标与力度", "## 交付",
	];
	const at = order.map((heading) => prompt.indexOf(`\n${heading}\n`));
	assert.ok(at.every((one) => one > 0), JSON.stringify(order.filter((_, i) => at[i] < 0)));
	assert.deepEqual([...at].sort((a, b) => a - b), at, "顺序照任务说明");
	assert.match(prompt, /先只审：原会话答复修哪几条之前不改任何文件/);
	assert.match(prompt, /用户原话和决定最高，计划次之/);
	assert.ok(prompt.includes(`## 背景\n\n${ARGS.background}`));
	assert.ok(prompt.includes(`### 原会话整理的决定与约束\n\n${ARGS.decisions}`));
	assert.ok(prompt.includes('<user_messages>\n<user_message n="1">\n最初的需求\n</user_message>\n\n（中间省略了 5 条）\n\n<user_message n="7">'));
	assert.ok(prompt.includes('</user_message>\n</user_messages>\n\n## 计划原文'), "原话整段包在 <user_messages> 里，紧接着是计划");
	assert.ok(prompt.includes("<approved_plan>\n# 计划\n\n改登录\n</approved_plan>"));
	assert.ok(prompt.includes("- `src/auth.ts` — 加 OAuth 回调路由和失败分支"));
	assert.ok(prompt.includes(`## 审阅重点\n\n${ARGS.focus}`));
	assert.ok(prompt.includes("Arguments: --effort high"));
	assert.match(prompt, /## 交付\n\n审完先照第 F 步问「登录改走 OAuth」修哪几条：它的地址是 `登录改走 OAuth \[a1b2c3\]`，用 `ask_session`/, "第 F 步要的地址在交接单里，不用它去 list_sessions 里认");
});
