/**
 * 自己发出去的那条消息，气泡里画什么。
 *
 * 两件事在这里钉住：
 *
 * 一、**气泡画的是人打的那句话**。`### Attached file: image.png` 这种写给模型的记号不该出现在人眼前
 *    ——侧边聊天从前就这样摊开过。现在侧边聊天也是会话，和主会话用同一个 `UserMessage`，都先看
 *    `displayText`。
 *
 * 二、**markdown 走不走，看有没有附件标记**。没有标记就整段交给 markdown（`# 需求1` 是标题，
 *    不是一行井号）；有标记就保持行内，否则块级的 markdown 会把一句话切成三行。
 *
 * 三、**太长的折起来，短的不动**。这里没有排版，行高和正文高度是按测试需要垫进去的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { UserMessage } from "../../src/features/conversation/UserMessage.tsx";
import { click, mount } from "../helpers/mount.ts";

test("气泡把 markdown 画出来，而不是照抄井号和星号", async () => {
	const text = "# 需求1\n请检查**所有**已编辑文件";
	const view = await mount(h(UserMessage, { index: 0, message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } }));
	try {
		const bubble = view.find(".ly-user-bubble");
		assert.equal(bubble.querySelectorAll("h1").length, 1, "「# 需求1」是标题");
		assert.equal(bubble.querySelectorAll("strong").length, 1, "「**所有**」是加粗");
		assert.ok(!(bubble.textContent ?? "").includes("#"), "井号是标记，不该留在字里");
	} finally { await view.unmount(); }
});

test("带附件标记的那一句保持行内，不被 markdown 切成几行", async () => {
	const message = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "照着 【图片 1】 改一版" }],
		displayText: "照着 【图片 1】 改一版",
		attachments: [{ name: "shot.png", label: "图片 1", kind: "image" }],
		timestamp: 0,
	};
	const view = await mount(h(UserMessage, { index: 0, message }));
	try {
		const bubble = view.find(".ly-user-bubble");
		assert.equal(bubble.querySelectorAll(".ly-attachment-token").length, 1, "标记画成一枚胶囊");
		// 一个段落，不是「段落、胶囊、段落」三块。
		assert.equal(bubble.querySelectorAll("p").length, 1);
		const shown = bubble.textContent ?? "";
		assert.ok(shown.includes("照着") && shown.includes("图片 1") && shown.includes("改一版"));
	} finally { await view.unmount(); }
});

test("气泡画的是人打的那句话，不是展开给模型的那一串", async () => {
	/*
	 * `content` 是送给模型的：附件正文被展开进去，带着 `### Attached file:` 的标题。
	 * `displayText` 是同一条消息里人实际打的字。气泡要画后者。
	 */
	const message = {
		role: "user" as const,
		content: [
			{ type: "text" as const, text: "\n\n### Attached file: image.png\n```\n二进制\n```\n\n" },
			{ type: "text" as const, text: "让主聊天看看这里面有什么内容吗？" },
		],
		displayText: "让主聊天看看这里面有什么内容吗？",
		attachments: [{ name: "image.png", label: "图片 1", kind: "image" }],
		timestamp: 0,
	};
	const view = await mount(h(UserMessage, { index: 0, message }));
	try {
		const bubble = view.find(".ly-user-bubble");
		const shown = bubble.textContent ?? "";
		assert.ok(shown.includes("让主聊天看看"), "人打的那句话在");
		assert.ok(!shown.includes("Attached file"), "写给模型的记号不该出现在气泡里");
		assert.ok(!shown.includes("二进制"), "附件正文更不该");
	} finally { await view.unmount(); }
});

test("老消息没有 displayText 时，仍然照原来的拼法画出来", async () => {
	// 早先发的消息没有这两个字段——少一枚胶囊，好过整条消息不见。
	const message = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "一条老消息" }],
		timestamp: 0,
	};
	const view = await mount(h(UserMessage, { index: 0, message }));
	try {
		assert.ok((view.find(".ly-user-bubble").textContent ?? "").includes("一条老消息"));
	} finally { await view.unmount(); }
});

/** 让这份 DOM 以为正文有多高、一行有多高——它自己不排版，两样都是 0。 */
async function withLayout<T>(height: number, run: () => Promise<T>): Promise<T> {
	const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
	const computed = globalThis.getComputedStyle;
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => height });
	// 计算出来的样式是只读的，赋值会被吞掉，只能整个换掉。
	globalThis.getComputedStyle = (() => ({ lineHeight: "24px" })) as unknown as typeof window.getComputedStyle;
	try {
		return await run();
	} finally {
		if (offset) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offset);
		globalThis.getComputedStyle = computed;
	}
}

const sent = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

test("超过十四行的消息折起来，按钮展开、再收起", async () => {
	await withLayout(24 * 40, async () => {
		const view = await mount(h(UserMessage, { index: 0, message: sent("很长的一段") }));
		try {
			const fold = view.find(".ly-bubble-fold");
			const toggle = view.find("[data-ly-bubble-fold-toggle]");
			assert.ok(fold.hasAttribute("data-folded"), "第一帧就是折着的");
			assert.equal(fold.style.maxHeight, "10lh");
			assert.equal(toggle.getAttribute("aria-expanded"), "false");
			await click(toggle);
			assert.ok(!fold.hasAttribute("data-folded"), "展开后不再压高度");
			assert.equal(fold.style.maxHeight, "");
			assert.equal(toggle.getAttribute("aria-expanded"), "true");
			await click(toggle);
			assert.ok(fold.hasAttribute("data-folded"), "还能收回去");
		} finally { await view.unmount(); }
	});
});

test("只比折叠线多一两行的消息不折：点开也看不到多少东西", async () => {
	await withLayout(24 * 12, async () => {
		const view = await mount(h(UserMessage, { index: 0, message: sent("十二行") }));
		try {
			assert.ok(!view.find(".ly-bubble-fold").hasAttribute("data-folded"));
			assert.equal(view.all("[data-ly-bubble-fold-toggle]").length, 0);
		} finally { await view.unmount(); }
	});
});
