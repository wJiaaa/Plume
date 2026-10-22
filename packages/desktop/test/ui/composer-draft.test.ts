import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { Composer } from "../../src/features/composer/Composer.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

for (const switched of [false, true]) {
	test(`a rejected send restores its session references ${switched ? "without changing another draft" : "in the visible composer"}`, async () => {
		const previous = useApp.getState();
		const refs = [{ id: "one", title: "同名引用" }, { id: "two", title: "同名引用" }];
		let finish!: (accepted: boolean) => void;
		let sentRefs: typeof refs | undefined;
		useApp.setState({ activeSessionId: "a", meta: null, workspace: null, scratchCwd: "/test", settings: null,
			messages: [], running: false, drafts: { a: { text: "恢复这条消息", attachments: [], sessionRefs: refs }, b: { text: "另一份草稿", attachments: [], sessionRefs: [{ id: "other", title: "独立引用" }] } },
			send: async (_content, options) => { sentRefs = options?.sessionRefs; return new Promise<boolean>((resolve) => { finish = resolve; }); },
		});
		Object.defineProperty(window, "plume", { configurable: true, value: { commands: { list: async () => ({ commands: [], skills: [], agents: [] }) } } });
		const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Composer) }) }));
		try {
			await click(view.find('[aria-label="发送"]'));
			assert.deepEqual(sentRefs, refs);
			assert.equal(view.find<HTMLTextAreaElement>("textarea").value, "");
			if (switched) await act(async () => { useApp.setState({ activeSessionId: "b" }); });
			await act(async () => { finish(false); });
			assert.deepEqual(useApp.getState().drafts.a.sessionRefs, refs);
			assert.equal(view.find<HTMLTextAreaElement>("textarea").value, switched ? "另一份草稿" : "恢复这条消息");
			if (switched) {
				assert.deepEqual(useApp.getState().drafts.b.sessionRefs, [{ id: "other", title: "独立引用" }]);
				assert.equal(view.all('[aria-label^="移除会话引用："]').length, 1);
			} else assert.equal(view.all('[aria-label^="移除会话引用："]').length, 2);
		} finally { await view.unmount(); useApp.setState(previous, true); }
	});
}

/*
 * 主输入框换会话时，A 的字不能写进 B 名下——哪怕只是一帧。
 *
 * 侧边聊天和子智能体的框早就用 `useDraft` 修过这件事；主输入框自己手写了一份按键存的同步，换键那次
 * 提交里 state 还是 A 的字、键已经是 B，于是 A 的草稿被写到了 B 名下，屏幕上也闪了一帧 A 的字。
 */
test("switching conversations never writes A's draft under B, nor paints it there", async () => {
	const previous = useApp.getState();
	useApp.setState({ activeSessionId: "a", meta: null, workspace: null, scratchCwd: "/test", settings: null, messages: [], running: false,
		drafts: { a: { text: "写给 A 的半句话", attachments: [] }, b: { text: "写给 B 的", attachments: [] } } });
	Object.defineProperty(window, "plume", { configurable: true, value: { commands: { list: async () => ({ commands: [], skills: [], agents: [] }) } } });
	const writtenToB: string[] = [];
	const stop = useApp.subscribe((state) => { const b = state.drafts.b; if (b) writtenToB.push(b.text); });
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Composer) }) }));
	try {
		assert.equal(view.find<HTMLTextAreaElement>("textarea").value, "写给 A 的半句话");
		await act(async () => { useApp.setState({ activeSessionId: "b" }); });
		assert.equal(view.find<HTMLTextAreaElement>("textarea").value, "写给 B 的");
		assert.ok(!writtenToB.includes("写给 A 的半句话"), `B 名下出现过 A 的字：${JSON.stringify(writtenToB)}`);
		assert.equal(useApp.getState().drafts.a?.text, "写给 A 的半句话");
	} finally { stop(); await view.unmount(); useApp.setState(previous, true); }
});
