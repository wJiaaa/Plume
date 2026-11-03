/**
 * 显示给人看的路径，在 Windows 上也只显示该显示的那一段。
 *
 * 主进程在 Windows 上给的路径是反斜杠的；只按 "/" 切，切不开，于是整条 `C:\…` 原样顶到界面上：
 * 工具折叠头写成「读取文件 C:\repo\src\foo.ts」，悬停卡片的文件夹行是整条路径。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";

import { WorkStep } from "../../src/features/conversation/WorkStep.tsx";
import { SessionCard } from "../../src/features/sidebar/SessionCard.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { mount } from "../helpers/mount.ts";

test("会话悬停卡片的文件夹行只写文件夹名", async () => {
	const session = {
		id: "s1",
		title: "会话",
		cwd: "C:\\Users\\me\\proj",
		projectName: "proj",
		messageCount: 3,
		updatedAt: Date.now(),
		createdAt: Date.now(),
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const anchor = { left: 0, right: 200, top: 0, bottom: 24, width: 200, height: 24, x: 0, y: 0, toJSON: () => ({}) };
	const view = await mount(h(SessionCard, { session: session as never, anchor: anchor as DOMRect }));
	try {
		// Portalled to the body, not drawn inside the mount point.
		const card = document.querySelector("[data-ly-session-card]")?.textContent ?? "";
		assert.ok(card.includes("proj"), card);
		assert.ok(!card.includes("C:\\"), `整条路径漏出来了：${card}`);
	} finally {
		await view.unmount();
	}
});

test("工具折叠头只写文件名", async () => {
	// 一次调用前面想过，这一段才折成一行、说的是总的那句；只有一次调用的那一行说的是相对工作区的路径。
	const call = {
		block: { type: "toolCall" as const, id: "read-1", name: "read", arguments: { path: "C:\\repo\\src\\foo.ts" } },
		stopReason: "toolUse" as const,
	};
	const thought = { kind: "thinking" as const, run: { kind: "message", message: { role: "assistant", content: [] }, upTo: 0 } as never };
	const step = { key: "step-read-1", category: "explore", calls: [call], members: [thought, { kind: "call" as const, call }] };
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(WorkStep, { step, live: false, draw: () => null }) }));
	try {
		assert.ok(view.text().includes("foo.ts"), view.text());
		assert.ok(!view.text().includes("C:\\"), `整条路径漏出来了：${view.text()}`);
	} finally {
		await view.unmount();
	}
});
