import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useEffect, useLayoutEffect, useState } from "react";
import { Terminal } from "lucide-react";
import { DockView } from "../../src/features/dock/DockView.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { registerPanels } from "../../src/features/dock/panels/registry.ts";
import { flushTree, paneStorageKey, writeTree } from "../../src/features/dock/persist.ts";
import { leafOf } from "../../src/features/dock/tree.ts";
import { usePanelKind } from "../../src/app/session-scope.tsx";
import { mount } from "../helpers/mount.ts";

/** One screen, the way `SplitPane` draws it: the conversation's own title bar, then its body. */
function screen(scope: string, children: React.ReactNode, header: () => React.ReactNode = () => null) {
	Object.defineProperty(window, "plume", { configurable: true, value: { platform: "darwin" } });
	return h(LayoutProvider, { children: h(DockView, { scope, header, children }) });
}

test("opening and closing a panel retains the conversation's DOM", async () => {
	window.localStorage.clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, host: null });
	const unregister = registerPanels([{
		kind: "terminal", label: "common.terminal", icon: Terminal, shortcut: "",
		render: () => h("input", { "data-test-terminal": "", defaultValue: "shell scrollback" }),
	}]);
	const view = await mount(screen("retain", h("textarea", { "data-test-chat": "" }), () => h("header", { "data-test-chrome": "" })));
	try {
		const conversation = view.find("[data-test-chat]");
		assert.equal(view.find("[data-test-chrome]").closest('[data-ly-pane-slot="conversation"]'), conversation.closest('[data-ly-pane-slot="conversation"]'));
		await act(() => { usePaneDock.getState().open("retain", "terminal"); });
		assert.ok(view.find("[data-test-chat]") === conversation, "opening a panel remounted the composer");
		assert.ok(view.find("[data-test-terminal]"));
		await act(() => { usePaneDock.getState().close("retain", "terminal"); });
		assert.ok(view.find("[data-test-chat]") === conversation, "closing a panel remounted the composer");
	} finally {
		await view.unmount();
		unregister();
		Reflect.deleteProperty(window, "plume");
	}
});

/*
 * The conversation restores its scroll position in a layout effect, and children's layout effects
 * run before `DockView`'s own `hydrate`. If the commit that switches to a conversation still drew
 * the bare layout, the transcript was measured at full width and its position clamped there before
 * the stored panel came back and narrowed the column.
 */
test("switching to a conversation lays out its stored panels in the same commit", async () => {
	window.localStorage.clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, host: null });
	const unregister = registerPanels([{
		kind: "terminal", label: "common.terminal", icon: Terminal, shortcut: "",
		render: () => h("input", { "data-test-terminal": "" }),
	}]);
	writeTree(paneStorageKey("with-panel"), { type: "split", dir: "row", children: [leafOf("conversation"), leafOf("terminal")], sizes: [0.6, 0.4] });
	flushTree();
	const seen: [string, boolean][] = [];
	function Transcript({ scope }: { scope: string }) {
		useLayoutEffect(() => {
			seen.push([scope, Boolean(document.querySelector("[data-test-terminal]"))]);
		}, [scope]);
		return null;
	}
	const view = await mount(screen("bare", h(Transcript, { scope: "bare" })));
	try {
		await view.rerender(screen("with-panel", h(Transcript, { scope: "with-panel" })));
		assert.deepEqual(seen.find(([scope]) => scope === "with-panel"), ["with-panel", true], "the transcript's first layout effect ran against the bare layout");
	} finally {
		await view.unmount();
		unregister();
		Reflect.deleteProperty(window, "plume");
	}
});

/*
 * 后台标签里的侧边聊天整个停下（`RetainedPanel`）：它的 effect 拆掉、内容不排版，切回来时局部状态
 * 还在。终端不在此列，藏着时照旧挂着、照旧排版。
 */
test("a side chat behind another tab is suspended, and comes back as it was", async () => {
	window.localStorage.clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, host: null });
	const live = new Set<string>();
	function Chat() {
		const id = usePanelKind() ?? "";
		const [said] = useState(() => `draft ${id}`);
		useEffect(() => {
			live.add(id);
			return () => void live.delete(id);
		}, [id]);
		return h("textarea", { "data-test-side": id, defaultValue: said });
	}
	const unregister = registerPanels([
		{ kind: "chat", label: "dock.sideChat", icon: Terminal, shortcut: "", render: Chat },
		{ kind: "terminal", label: "common.terminal", icon: Terminal, shortcut: "", render: () => h("input", { "data-test-terminal": "" }) },
	]);
	const view = await mount(screen("sides", h("main")));
	try {
		await act(() => { usePaneDock.getState().open("sides", "chat"); });
		const first = view.find('[data-test-side="chat"]');
		assert.ok(live.has("chat"));
		await act(() => { usePaneDock.getState().open("sides", "chat:second"); });
		assert.ok(!live.has("chat"), "the side chat behind the new tab kept its effects running");
		assert.ok(live.has("chat:second"));
		assert.ok(first.closest<HTMLElement>('[style*="display: none"]'), "the side chat behind the new tab is still laid out");
		await act(() => { usePaneDock.getState().open("sides", "chat"); });
		assert.ok(live.has("chat"), "the side chat did not resume when brought back");
		assert.ok(view.find('[data-test-side="chat"]') === first, "bringing the side chat back remounted it");
		await act(() => { usePaneDock.getState().open("sides", "terminal"); });
		assert.ok(live.has("chat") === false);
		assert.notEqual(getComputedStyle(view.find("[data-test-terminal]")).display, "none");
	} finally {
		await view.unmount();
		unregister();
		Reflect.deleteProperty(window, "plume");
	}
});
