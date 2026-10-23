import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantContent, Message } from "@plume/core";
import { closeOpenFence, conversationMarkdown, inlineCode, markdownFileName } from "../electron/session/conversation-markdown.ts";
import { nativeTranslator } from "../electron/i18n.ts";

const zh = nativeTranslator("zh-CN", "zh-CN");
const en = nativeTranslator("en", "en");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: AssistantContent[], model = "opus", extra: Partial<Extract<Message, { role: "assistant" }>> = {}): Message => ({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model, usage, stopReason: "stop", timestamp: 2, ...extra });
const call = (id: string, name: string, args: Record<string, unknown>): AssistantContent => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, text: string, extra: Partial<Extract<Message, { role: "toolResult" }>> = {}): Message => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 3, ...extra });
const at = new Date(2026, 9, 23, 14, 5);

const transcript: Message[] = [
	{
		role: "user",
		content: [
			{ type: "text", text: "照着【图片 1】改，参考 report.pdf" },
			{ type: "image", data: "", mimeType: "image/png", media: "a.png" },
			{ type: "image", data: "", mimeType: "image/jpeg", media: "b.jpg" },
			{ type: "text", text: "\n\n### Attached file: report.pdf\nSECRET BODY" },
		],
		displayText: "照着【图片 1】改，参考 report.pdf",
		attachments: [
			{ name: "dji_mimo_0001_photo.JPG", kind: "image", mimeType: "image/jpeg" },
			{ name: "report.pdf", kind: "document" },
			{ name: "image.png", kind: "image", label: "图片 2" },
		],
		timestamp: 1,
	},
	reply([
		{ type: "thinking", thinking: "PRIVATE REASONING" },
		{ type: "text", text: "先看一下代码。" },
		call("c1", "read", { path: "src/a_b*c.ts" }),
		call("c2", "bash", { command: "echo `date` ```" }),
	]),
	result("c1", "read", "FILE CONTENT ".repeat(1000)),
	result("c2", "bash", "TOOL OUTPUT", { isError: true }),
	reply([call("c3", "task", { description: "找调用方", prompt: "INNER PROMPT" })]),
	result("c3", "task", "已派出", { details: { kind: "task", detached: true } }),
	reply([{ type: "text", text: "代码里有反引号：\n\n````md\n```ts\nconst a = `x`;\n```\n````" }]),
	{
		role: "user",
		synthetic: true,
		timestamp: 4,
		delivery: [{ id: "s1", agent: "explore", description: "找调用方", status: "done" }],
		content: [
			{ type: "text", text: "（运行时送达）你之前派出去的子代理有结果了：" },
			{ type: "text", text: '<subagent_result id="s1" agent="explore" task="找调用方" status="done">\n调用方有两个：\n\n- a.ts\n- b.ts\n</subagent_result>' },
			{ type: "text", text: "派出去的都回来了。" },
		],
	},
	{ role: "user", synthetic: true, content: [{ type: "text", text: "RUNTIME NUDGE" }], timestamp: 5 },
	reply([{ type: "text", text: "换了模型之后的回答，写到一半断了：\n```ts\nconst x = 1;" }], "gpt-5"),
];

test("a conversation reads as what was said and done, not as the trajectory behind it", () => {
	const md = conversationMarkdown({ title: "修登录", cwd: "/work/app", messages: transcript, compactions: [6], exportedAt: at }, zh);

	assert.match(md, /^# 修登录\n\n- 导出时间：2026-10-23 14:05\n- 项目：\/work\/app\n- 模型：anthropic\/opus、anthropic\/gpt-5\n/);
	assert.match(md, /## 用户\n\n照着【图片 1】改，参考 report\.pdf\n\n附件：图片 1、report\.pdf、图片 2/);
	// 机器起的图片名、附件正文、思考、工具输出、子智能体的内部提示词、运行时插的话，都不进导出。
	for (const hidden of ["dji_mimo", "SECRET BODY", "PRIVATE REASONING", "FILE CONTENT", "TOOL OUTPUT", "INNER PROMPT", "RUNTIME NUDGE", "已派出"]) assert.ok(!md.includes(hidden), hidden);

	// 工具调用一条一行：名字、摘要；摘要里的 `*` `_` 不变成格式，带反引号的命令关不掉行内代码。
	assert.match(md, /- `read` Read src\/a\\_b\\\*c\.ts\n- `bash` echo \\`date\\` \\`\\`\\`（失败）/);
	// 隔着几条工具结果、分在几条回复里的调用，还是同一张列表。
	assert.match(md, /（失败）\n- `task` 找调用方/);
	assert.match(md, /\*— 上下文在这里压缩过，之前的内容由摘要代替 —\*\n\n## 助手\n\n代码里有反引号/);
	assert.ok(md.includes("````md\n```ts\nconst a = `x`;\n```\n````"), "a reply's own fences pass through untouched");

	// 子智能体只写结论，整段在引用里，空行也带着 `>`。
	assert.match(md, /### 子智能体 explore 的结论：找调用方\n\n> 调用方有两个：\n>\n> - a\.ts\n> - b\.ts/);
	assert.match(md, /\*— 模型已切换 anthropic\/opus → anthropic\/gpt-5 —\*\n\n## 助手\n\n换了模型之后/);
	// 写到一半的代码块被合上，后面的东西不会全成了代码。
	assert.ok(md.endsWith("const x = 1;\n```\n"));
});

test("model names come from the settings when there is one, and the export follows the interface language", () => {
	const md = conversationMarkdown({ title: "", cwd: "", messages: transcript.slice(0, 2), compactions: [], exportedAt: at, modelLabel: (provider, model) => `Anthropic/Claude ${model}` }, en);
	assert.match(md, /^# Untitled conversation\n\n- Exported: 2026-10-23 14:05\n- Models: Anthropic\/Claude opus\n/);
	assert.ok(!md.includes("Project:"));
	assert.match(md, /## You\n[\s\S]*Attachments: Image 1, report\.pdf, Image 2[\s\S]*## Assistant/);
});

test("an empty conversation still exports, and says it is empty", () => {
	const md = conversationMarkdown({ title: "新对话", cwd: "/w", messages: [], compactions: [], exportedAt: at }, zh);
	assert.equal(md, "# 新对话\n\n- 导出时间：2026-10-23 14:05\n- 项目：/w\n\n这个会话还没有消息。\n");
});

test("a sub-agent that answered in place, from before dispatches went to the background, keeps its conclusion", () => {
	const md = conversationMarkdown({ title: "t", cwd: "", messages: [reply([call("c", "task", { description: "查" })]), result("c", "task", "结论在这里")], compactions: [], exportedAt: at }, zh);
	assert.match(md, /- `task` 查\n\n> 结论在这里/);
});

test("a monitor's batches and a scheduled wakeup are said as what they are, not as a finished command or a sub-agent", () => {
	const delivered = (delivery: NonNullable<Extract<Message, { role: "user" }>["delivery"]>): Message => ({ role: "user", synthetic: true, timestamp: 4, delivery, content: [{ type: "text", text: "<monitor_events>RAW LOG</monitor_events>" }] });
	const messages = [
		delivered([{ id: "m", kind: "job", agent: "", description: "盯构建", command: "tail -f b.log", status: "done", monitor: { lines: 3 } }]),
		delivered([{ id: "m", kind: "job", agent: "", description: "盯构建", command: "tail -f b.log", status: "done", monitor: { lines: 1, stopped: "idle" } }]),
		delivered([{ id: "w", kind: "wakeup", agent: "", description: "回来看 CI", status: "done" }]),
	];
	const md = conversationMarkdown({ title: "t", cwd: "", messages, compactions: [], exportedAt: at }, zh);
	assert.match(md, /- 监视到 3 行新输出：盯构建/);
	assert.match(md, /- 监视已停止：盯构建/);
	assert.match(md, /- 定时唤醒：回来看 CI/);
	assert.doesNotMatch(md, /后台命令结束|子智能体|RAW LOG/);
});

test("a message that only invoked a skill is exported as the command the person typed, not dropped", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "做完了" }], displayText: "做完了", timestamp: 1 },
		reply([{ type: "text", text: "好的。" }]),
		{ role: "user", content: [{ type: "text", text: "Use the `simplify` skill." }], displayText: "", skillRef: { name: "simplify" }, timestamp: 3 },
		reply([{ type: "text", text: "审阅完成。" }]),
		{ role: "user", content: [{ type: "text", text: "Use the `pdf` skill." }], displayText: "看一下", skillRef: { name: "pdf", pluginId: "docs" }, timestamp: 5 },
	];
	const md = conversationMarkdown({ title: "t", cwd: "", messages, compactions: [], exportedAt: at }, zh);
	assert.match(md, /## 用户\n\n\/simplify\n\n## 助手\n\n审阅完成。/);
	assert.match(md, /## 用户\n\n\/docs:pdf 看一下/);
	assert.doesNotMatch(md, /Use the/);
});

test("fences and inline code are always longer than what they hold", () => {
	assert.equal(inlineCode("a``b"), "```a``b```");
	assert.equal(inlineCode("`x"), "`` `x ``");
	assert.equal(closeOpenFence("```\nclosed\n```"), "```\nclosed\n```");
	assert.equal(closeOpenFence("~~~~\nopen ```\n```"), "~~~~\nopen ```\n```\n~~~~");
	assert.equal(closeOpenFence("inline ``` is not a fence"), "inline ``` is not a fence");
});

test("a title becomes a file name every platform accepts", () => {
	assert.equal(markdownFileName("修复 a/b: \"登录\" <失败>?", "x"), "修复 a_b_ _登录_ _失败__.md");
	assert.equal(markdownFileName("  结尾有点.  ", "x"), "结尾有点.md");
	assert.equal(markdownFileName("CON", "x"), "_CON.md");
	assert.equal(markdownFileName("nul.txt", "x"), "_nul.txt.md");
	assert.equal(markdownFileName("\u0001\t\n", "未命名会话"), "未命名会话.md");
	assert.equal(markdownFileName("长".repeat(300), "x"), `${"长".repeat(120)}.md`);
});
