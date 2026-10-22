/**
 * 下一步建议：最新那条回复末尾写的那句是输入框空着时的灰字，Tab 填入；回复里不画它。
 * 见 `@plume/core/followups` 和 `lib/followups.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { AssistantMessage, Message } from "@plume/core";
import { Composer } from "../../src/features/composer/Composer.tsx";
import { Markdown } from "../../src/features/markdown/Markdown.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { mount, press } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const REPLY = "修好了，e2e 还没跑。\n\n:followup[把登录页的 e2e 跑一遍，失败的话贴出第一条报错]";

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "t", model: "t", usage, stopReason, timestamp: 2 };
}

const asked: Message = { role: "user", content: [{ type: "text", text: "修一下登录跳转" }], timestamp: 1 };

async function composerWith(messages: Message[], draft?: string) {
	const previous = useApp.getState();
	useApp.setState({
		activeSessionId: "s",
		meta: null,
		workspace: null,
		scratchCwd: "/test",
		settings: null,
		messages,
		running: false,
		stopped: null,
		todos: [],
		drafts: draft ? { s: { text: draft, attachments: [], sessionRefs: [] } } : {},
	});
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: { commands: { list: async () => ({ commands: [], skills: [], agents: [] }) }, sessions: { contextBreakdown: async () => null } },
	});
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Composer) }) }));
	return {
		field: () => view.find("textarea") as HTMLTextAreaElement,
		restore: async () => {
			await view.unmount();
			useApp.setState(previous, true);
		},
	};
}

test("an empty box shows the first follow-up and Tab fills it in", async () => {
	const composer = await composerWith([asked, reply(REPLY)]);
	try {
		assert.equal(composer.field().placeholder, "把登录页的 e2e 跑一遍，失败的话贴出第一条报错");
		await press(composer.field(), "Tab");
		assert.equal(composer.field().value, "把登录页的 e2e 跑一遍，失败的话贴出第一条报错");
	} finally {
		await composer.restore();
	}
});

test("with something typed, Tab is not taken", async () => {
	const composer = await composerWith([asked, reply(REPLY)], "换个说法");
	try {
		await press(composer.field(), "Tab");
		assert.equal(composer.field().value, "换个说法");
	} finally {
		await composer.restore();
	}
});

test("no hint once the person has spoken again, or while the reply is still being written", async () => {
	for (const messages of [[asked, reply(REPLY), { ...asked, timestamp: 3 }], [asked, reply(REPLY, "pending")], [asked, reply("修好了。")]]) {
		const composer = await composerWith(messages);
		try {
			assert.notEqual(composer.field().placeholder, "把登录页的 e2e 跑一遍，失败的话贴出第一条报错");
			await press(composer.field(), "Tab");
			assert.equal(composer.field().value, "");
		} finally {
			await composer.restore();
		}
	}
});

test("the reply does not show it, and leaves no gap where it was", async () => {
	const view = await mount(h(Markdown, { text: REPLY }));
	try {
		assert.equal(view.text(), "修好了，e2e 还没跑。");
		assert.equal(view.all("p").length, 1, "标记那一行整行拿掉，不留一段空的");
	} finally {
		await view.unmount();
	}
});
