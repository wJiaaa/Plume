import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { Markdown } from "../../src/features/markdown/Markdown.tsx";
import { Disclosure } from "../../src/ui/layout/Disclosure.tsx";
import { click, mount } from "../helpers/mount.ts";

test("a fold left to itself starts closed, opens on click, and keeps a closed body out of the tab order", async () => {
	const view = await mount(h(Disclosure, { variant: "framed", title: "高级定义", children: h("p", null, "正文") }));
	try {
		const head = view.find<HTMLButtonElement>("button[aria-expanded]");
		const body = view.find(".ly-reveal");
		assert.equal(head.getAttribute("aria-expanded"), "false");
		assert.equal(body.dataset.open, "false");
		assert.ok(body.hasAttribute("inert"), "a closed body must be inert, or its links stay tabbable while invisible");
		assert.equal(view.host.querySelector("details"), null, "the browser's own disclosure must not be what renders");
		assert.ok(head.querySelector("svg"), "the chevron is drawn, not typed");
		await click(head);
		assert.equal(head.getAttribute("aria-expanded"), "true");
		assert.equal(body.dataset.open, "true");
		assert.ok(!body.hasAttribute("inert"));
	} finally {
		await view.unmount();
	}
});

test("defaultOpen starts a fold open", async () => {
	const view = await mount(h(Disclosure, { variant: "compact", title: "组件栈", defaultOpen: true, children: "栈" }));
	try {
		assert.equal(view.find("button[aria-expanded]").getAttribute("aria-expanded"), "true");
		assert.equal(view.find(".ly-reveal").dataset.open, "true");
	} finally {
		await view.unmount();
	}
});

test("a controlled fold reports the click and leaves the state to its owner", async () => {
	let toggles = 0;
	const props = { title: "检查", count: 3, open: false, onToggle: () => { toggles++; }, children: "内容" };
	const view = await mount(h(Disclosure, props));
	try {
		assert.equal(view.find("button[aria-expanded] .tabular-nums").textContent, "3", "the count sits beside the title rather than inside it");
		await click(view.find("button[aria-expanded]"));
		assert.equal(toggles, 1);
		assert.equal(view.find("button[aria-expanded]").getAttribute("aria-expanded"), "false", "the owner has not said open yet");
		await view.rerender(h(Disclosure, { ...props, open: true }));
		assert.equal(view.find("button[aria-expanded]").getAttribute("aria-expanded"), "true");
		assert.ok(!view.find(".ly-reveal").hasAttribute("inert"));
	} finally {
		await view.unmount();
	}
});

test("a <details> block in Markdown folds with the app's disclosure, its summary rendered as Markdown", async () => {
	const view = await mount(h(Markdown, { text: "<details>\n<summary>展开**日志**</summary>\n\n一行日志\n\n</details>" }));
	try {
		assert.equal(view.host.querySelector("details"), null);
		const head = view.find("button[aria-expanded]");
		assert.equal(head.getAttribute("aria-expanded"), "false");
		assert.ok(head.querySelector("strong"), "inline Markdown in the summary survives");
		assert.match(view.text(), /一行日志/, "the body is in the tree, folded, rather than absent");
		await click(head);
		assert.equal(view.find(".ly-reveal").dataset.open, "true");
	} finally {
		await view.unmount();
	}
});
