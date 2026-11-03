import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { act } from "react";
import { EditorView } from "@codemirror/view";
import { searchPanelOpen } from "@codemirror/search";

import { CodeEditor } from "../../src/features/editor/CodeEditor.tsx";
import { mount } from "../helpers/mount.ts";

/** The file preview is read-only, but still takes the keyboard — otherwise ⌘F has nowhere to land. */
test("the file preview offers no editable surface, and ⌘F still opens find", async () => {
	// `.txt` so no grammar is fetched: this is about the document, not its highlighting.
	const mounted = await mount(h(CodeEditor, { path: "/project/notes.txt", text: "one\ntwo\n" }));
	try {
		const dom = mounted.host.querySelector<HTMLElement>(".cm-editor");
		assert.ok(dom, "编辑器应该已经挂上");
		const view = EditorView.findFromDOM(dom);
		assert.ok(view, "应该能从 DOM 找到 EditorView");

		assert.equal(view.state.readOnly, true);
		assert.equal(view.state.facet(EditorView.editable), false);
		assert.equal(view.contentDOM.contentEditable, "false");
		assert.equal(view.contentDOM.getAttribute("aria-readonly"), "true");
		assert.equal(view.contentDOM.tabIndex, 0, "不可编辑的内容区要能拿到焦点，快捷键才有地方按");

		await act(async () => {
			view.contentDOM.focus();
			view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", keyCode: 70, metaKey: true, bubbles: true, cancelable: true }));
		});
		assert.equal(searchPanelOpen(view.state), true, "⌘F 应该打开查找");
		assert.equal(mounted.host.querySelector(".cm-search input[name=replace]"), null, "只读预览不该有替换");
	} finally {
		await mounted.unmount();
	}
});

/**
 * 每换一个文件就重建一次视图，跟着新建一个看查找栏的观察器。从前清理时不断开它：切过 30 个文件，
 * 42 个观察器还在盯着早就拆掉的 DOM。
 */
test("换过 30 个文件，活着的观察器不比打开第一个时多", async () => {
	const Native = globalThis.MutationObserver;
	const live = new Set<MutationObserver>();
	class Counted extends Native {
		override observe(target: Node, options?: MutationObserverInit) { live.add(this); super.observe(target, options); }
		override disconnect() { live.delete(this); super.disconnect(); }
	}
	globalThis.MutationObserver = Counted;
	const mounted = await mount(h(CodeEditor, { path: "/project/0.txt", text: "zero\n" }));
	try {
		const first = live.size;
		for (let index = 1; index <= 30; index++) await mounted.rerender(h(CodeEditor, { path: `/project/${index}.txt`, text: `${index}\n` }));
		assert.ok(live.size <= first, `打开第一个文件时 ${first} 个，换过 30 个以后 ${live.size} 个`);
	} finally {
		await mounted.unmount();
		globalThis.MutationObserver = Native;
	}
	assert.equal(live.size, 0, "卸载以后还有观察器没断开");
});
