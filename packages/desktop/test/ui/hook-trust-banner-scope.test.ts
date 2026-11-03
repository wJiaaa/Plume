/**
 * 分屏时，「项目钩子待审核」问的是这一屏的项目：从前读全局的 `workspace`，没聚焦的那一屏显示的是
 * 聚焦那一屏的待审钩子，「去审核」也落到那个项目。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, createElement as h } from "react";
import type { SessionMeta } from "@plume/core";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { HookTrustBanner } from "../../src/features/conversation/HookTrustBanner.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp, type AppState } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const meta = (id: string, cwd: string): SessionMeta => ({ id, title: id, cwd, projectId: cwd, projectName: id, createdAt: 1, updatedAt: 2, modelId: "", messageCount: 0, seq: 1, usage });
const previous: AppState = useApp.getState();

afterEach(() => {
	useApp.setState(previous, true);
	Reflect.deleteProperty(window, "plume");
});

test("没聚焦的那一屏问自己项目的钩子", async () => {
	const asked: string[] = [];
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			hooks: {
				list: async (path: string) => {
					asked.push(path);
					return { project: path === "/work/beta" ? [{ id: "h", command: "echo", trusted: false, enabled: true }] : [] };
				},
			},
		},
	});
	useApp.setState({
		activeSessionId: "a", meta: meta("a", "/work/alpha"), workspace: { path: "/work/alpha", name: "alpha", isGitRepo: false, branch: null },
		sessions: [meta("a", "/work/alpha"), meta("b", "/work/beta")], sessionCache: {}, scratchRoots: [],
	});
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionScope.Provider, { value: "b" }, h(HookTrustBanner)) }));
	try {
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		assert.deepEqual(asked, ["/work/beta"]);
		view.find("[data-ly-hook-trust-banner]");
	} finally {
		await view.unmount();
	}
});
