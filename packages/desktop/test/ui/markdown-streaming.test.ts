/**
 * 正在输出的回复怎么画——见 `useSmoothText`、`FadeText.tsx` 和 `stream-tail.ts`。
 *
 * 钉住这几件事：一次倒进来一大段时是一点点放出来的，不是整段蹦出来；新字淡入，同一帧放出来的合用
 * 一个 span；写完之后剩下的字照常放完、淡完，再换回原文——不在结束那一刻整段实着蹦出来；演到一半
 * 被重挂接着演；新起的一段淡入、早就在屏幕上的字不重放；半个拉丁词不放出来；写到一半的加粗画成加粗，
 * 不露出星号。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, StrictMode } from "react";
import type { AssistantMessage } from "@plume/core";
import { Markdown } from "../../src/features/conversation/Markdown.tsx";
import { MessageRow } from "../../src/features/conversation/rows.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { mount } from "../helpers/mount.ts";

const frames = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
/** 还在淡入的字一共几个（同一帧放出来的合用一个 span）。 */
const fadingChars = (elements: Element[]) => elements.reduce((sum, element) => sum + Array.from(element.textContent ?? "").length, 0);

test("一次进来的一大段按节奏放出来，同一帧的合用一个 span，写完之后剩下的字照常放完", async () => {
	const first = "第一段。";
	const burst = `${first}${"后面一口气进来的字。".repeat(20)}`;
	const view = await mount(h(Markdown, { text: first, streaming: true }));
	try {
		await frames(120);
		assert.equal(view.text(), first, "头一批字几帧内出完");

		await view.rerender(h(Markdown, { text: burst, streaming: true }));
		await frames(50);
		const partial = view.text().length;
		assert.ok(partial > first.length && partial < burst.length, `应该只放出一部分，实际 ${partial}/${burst.length}`);
		const spans = view.all(".ly-fade-char");
		assert.ok(spans.length > 0 && fadingChars(spans) >= spans.length * 2, `同一帧放出来的字合用一个 span：${spans.length} 个 span、${fadingChars(spans)} 个字`);

		await frames(1200);
		assert.equal(view.text(), burst, "积压的字在约定时间内放完");

		const more = `${burst}${"再来一段。".repeat(20)}`;
		await view.rerender(h(Markdown, { text: more, streaming: true }));
		await view.rerender(h(Markdown, { text: more, streaming: false }));
		assert.ok(view.text().length < more.length, "结束那一刻不整段蹦出来");
		await frames(1500);
		assert.equal(view.text(), more, "剩下的字放完");
		assert.equal(view.all(".ly-fade-char").length, 0, "淡完之后换回纯文本");
	} finally {
		await view.unmount();
	}
});

test("演到一半被重挂（一轮跑完换了父元素），新挂上的接着演，不重放、也不把剩下的一次画出来", async () => {
	const first = "第一段。";
	const burst = `${first}${"后面一口气进来的字。".repeat(30)}`;
	const before = await mount(h(Markdown, { text: first, streaming: true }));
	await before.rerender(h(Markdown, { text: burst, streaming: true }));
	await frames(100);
	const shown = before.text().length;
	assert.ok(shown > first.length && shown < burst.length, `重挂前只放出了一部分：${shown}/${burst.length}`);
	const after = await mount(h(Markdown, { text: burst, streaming: false }));
	await before.unmount();
	try {
		const resumed = after.text().length;
		assert.ok(resumed >= shown && resumed < burst.length, `接着上一段放：${shown} → ${resumed}/${burst.length}`);
		assert.ok(after.all(".ly-fade-char").length > 0, "新放出来的字照旧淡入");
		await frames(1500);
		assert.equal(after.text(), burst, "剩下的字放完");
		assert.equal(after.all(".ly-fade-char").length, 0, "淡完之后换回纯文本");
	} finally {
		await after.unmount();
	}
});

test("打开历史里的回复不淡入，也不会接上别处刚演完的那一段", async () => {
	const view = await mount(h(Markdown, { text: "另一段已经写完的回复。", streaming: false }));
	try {
		assert.equal(view.text(), "另一段已经写完的回复。");
		assert.equal(view.all(".ly-fade-char").length, 0);
	} finally {
		await view.unmount();
	}
});

test("新起的一段淡入；早就在屏幕上的那段字不重放", async () => {
	const first = "第一段早就在了。";
	const view = await mount(h(Markdown, { text: first, streaming: true }));
	try {
		// 两段等待：第一段里字放完、提交（`act` 把这期间的更新攒到结尾才提交），第二段让它们老过淡入的时长。
		await frames(120);
		await frames(250);
		await view.rerender(h(Markdown, { text: `${first}\n\n新起的一段。`, streaming: true }));
		await frames(60);
		const [old, fresh] = view.all("p");
		assert.equal(old.querySelectorAll(".ly-fade-char").length, 0, "老的那段一个字也不重放");
		assert.ok(fresh.querySelectorAll(".ly-fade-char").length > 0, "新起的一段在淡入");
	} finally {
		await view.unmount();
	}
});

test("正在打的半个拉丁词不放出来，上游停下了才放", async () => {
	const view = await mount(h(Markdown, { text: "", streaming: true }));
	try {
		await view.rerender(h(Markdown, { text: "Hello wor", streaming: true }));
		await frames(120);
		assert.equal(view.text(), "Hello", "wor 还扣着");
		await frames(300);
		assert.equal(view.text(), "Hello wor", "上游停了一阵，那就不是半个词");
		await view.rerender(h(Markdown, { text: "Hello world.", streaming: true }));
		await frames(120);
		assert.equal(view.text(), "Hello world.");
	} finally {
		await view.unmount();
	}
});

test("开发模式把组件挂上、卸下、再挂上一遍，出字不会卡在第一个字上", async () => {
	const text = "第一句话有十几个字，要分好几帧才放完。";
	const view = await mount(h(StrictMode, { children: h(Markdown, { text, streaming: true }) }));
	try {
		await frames(400);
		assert.equal(view.text(), text, "头一批字照常放完");
		await view.rerender(h(StrictMode, { children: h(Markdown, { text: `${text}后面接着来的字。`, streaming: true }) }));
		await frames(400);
		assert.equal(view.text(), `${text}后面接着来的字。`, "后面来的字也照常放");
	} finally {
		await view.unmount();
	}
});

test("写到一半的加粗画成加粗；写完之后画的是原文", async () => {
	const view = await mount(h(Markdown, { text: "这是 **加粗", streaming: true }));
	try {
		await frames(120);
		assert.equal(view.find("strong").textContent, "加粗");
		assert.ok(!view.text().includes("*"), "星号是标记，不该露出来");

		await view.rerender(h(Markdown, { text: "这是 **加粗", streaming: false }));
		await frames(600);
		assert.equal(view.all("strong").length, 0, "写完了还没收口，那就是作者写的原样");
	} finally {
		await view.unmount();
	}
});

test("主会话里正在输出的那段正文按流式来画", async () => {
	/*
	 * 接线本身要守：主会话这一行曾经拿「最新的一段推理」那个标记来判断，而正文行从来拿不到它，
	 * 于是流式画法在主会话里一次都没开过，单测却全绿。
	 */
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "这是 **加粗" }],
		api: "anthropic-messages",
		provider: "qa",
		model: "model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: 1,
	};
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(MessageRow, { message, index: 0, upTo: 1 }) }));
	try {
		await frames(120);
		assert.equal(view.find("strong").textContent, "加粗");
		assert.ok(!view.text().includes("**"), "星号是标记，不该露出来");
	} finally {
		await view.unmount();
	}
});

test("输出中的新字淡入，写完之后不留淡入用的 span", async () => {
	const view = await mount(h(Markdown, { text: "第一句。", streaming: true }));
	try {
		await view.rerender(h(Markdown, { text: "第一句。第二句接着来。", streaming: true }));
		await frames(40);
		assert.ok(view.all(".ly-fade-char").length > 0, "新出现的字应该是淡入的");
		assert.equal(view.text(), "第一句。第二句接着来。".slice(0, view.text().length), "淡入不改变字本身");

		await view.rerender(h(Markdown, { text: "第一句。第二句接着来。", streaming: false }));
		assert.ok(view.all(".ly-fade-char").length > 0, "结束那一刻不掐掉正在进行的淡入");
		await frames(1000);
		assert.equal(view.all(".ly-fade-char").length, 0, "淡完之后是纯文本");
		assert.equal(view.text(), "第一句。第二句接着来。");
	} finally {
		await view.unmount();
	}
});

test("一轮中间看着写完的一句，底下那行操作是长出来的；收尾那一句和打开历史时不演", async () => {
	const base: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "好的，需要的时候叫我。" }],
		api: "anthropic-messages",
		provider: "qa",
		model: "model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: 1,
	};
	const live = await mount(h(I18nProvider, { locale: "zh-CN", children: h(MessageRow, { message: base, index: 0, upTo: 1, continued: true, pauses: true }) }));
	try {
		await live.rerender(h(I18nProvider, { locale: "zh-CN", children: h(MessageRow, { message: { ...base, stopReason: "stop" }, index: 0, upTo: 1, continued: true, pauses: true }) }));
		assert.equal(live.all(".ly-actions-in").length, 1, "运行行还在底下，写完的那一刻展开，而不是一下子多出一行把回复顶上去");
	} finally {
		await live.unmount();
	}

	// 收尾那一句：操作行和运行行同一帧一出一进，再慢慢长就是先掉一行、再被顶回来。
	const closing = await mount(h(I18nProvider, { locale: "zh-CN", children: h(MessageRow, { message: base, index: 0, upTo: 1 }) }));
	try {
		await closing.rerender(h(I18nProvider, { locale: "zh-CN", children: h(MessageRow, { message: { ...base, stopReason: "stop" }, index: 0, upTo: 1 }) }));
		assert.ok(closing.all("button").length > 0, "操作行照常出现，只是不演");
		assert.equal(closing.all(".ly-actions-in").length, 0, "收尾那一句的操作行一下子就在，不从 0 长");
	} finally {
		await closing.unmount();
	}

	const history = await mount(h(I18nProvider, { locale: "zh-CN", children: h(MessageRow, { message: { ...base, stopReason: "stop" }, index: 0, upTo: 1 }) }));
	try {
		assert.equal(history.all(".ly-actions-in").length, 0);
	} finally {
		await history.unmount();
	}
});

test("输出中的代码块，新来的字也淡入；写完之后是原样的代码", async () => {
	const head = "看这段：\n\n```ts\nconst a = 1;\n";
	const code = `${head}${Array.from({ length: 40 }, (_, i) => `const n${i} = ${i};`).join("\n")}\n\`\`\``;
	const view = await mount(h(Markdown, { text: head, streaming: true }));
	try {
		await view.rerender(h(Markdown, { text: code, streaming: true }));
		await frames(200);
		assert.ok(view.all(".ly-code-block .ly-fade-char").length > 0, "代码块里新出现的字应该是淡入的");
		const shown = view.find(".ly-code-block pre").textContent ?? "";
		assert.ok(code.includes(shown), "淡入和分段不改变代码本身");

		await view.rerender(h(Markdown, { text: code, streaming: false }));
		await frames(1500);
		assert.equal(view.all(".ly-fade-char").length, 0, "淡完之后是纯文本");
		assert.equal(view.find(".ly-code-block pre").textContent, code.slice(code.indexOf("const a"), code.lastIndexOf("\n```")));
	} finally {
		await view.unmount();
	}
});
