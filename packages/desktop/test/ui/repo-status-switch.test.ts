/**
 * 切到另一个仓库，Git 面板不能拿上一个仓库的状态来顶。
 *
 * 从前在途的读取不分仓库：B 的刷新拿到 A 还没回来的那一次，回来以后也不核对就落地，于是 B 的
 * 名字下面列着 A 的文件。
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h } from "react";
import type { GitStatus } from "@plume/contract";
import { useRepoStatus } from "../../src/features/git/use-repo-status.ts";
import { mount } from "../helpers/mount.ts";

const statusOf = (branch: string): GitStatus => ({
	branch, upstream: null, ahead: 0, behind: 0, remoteState: "none", remote: null,
	operation: null, unpushed: null, head: null, staged: [], unstaged: [],
});

/** Every `git status` asked for, answered only when the test says so. */
function fixture(t: TestContext) {
	const asked: { cwd: string; answer: () => void }[] = [];
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	Object.defineProperty(window, "plume", { configurable: true, value: {
		git: { status: (cwd: string) => new Promise<GitStatus>((resolve) => asked.push({ cwd, answer: () => resolve(statusOf(cwd)) })) },
	} });
	t.after(() => { if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume"); });
	return asked;
}

let hook: ReturnType<typeof useRepoStatus>;
function Probe({ cwd }: { cwd: string | null }) {
	hook = useRepoStatus(cwd);
	return h("output", null, hook.status?.branch ?? "none");
}

test("换了仓库立刻不显示旧的，B 的刷新不复用 A 在途的读取，A 晚到的回答不落地", async (t) => {
	const asked = fixture(t);
	const view = await mount(h(Probe, { cwd: "/a" }));
	try {
		let flight = hook.refresh();
		await act(async () => { asked[0].answer(); await flight; });
		assert.equal(view.find("output").textContent, "/a");

		// A 的又一次读取还在路上，人切到了 B。
		void hook.refresh();
		await view.rerender(h(Probe, { cwd: "/b" }));
		assert.equal(view.find("output").textContent, "none", "B 的名字下面还挂着 A 的状态");

		flight = hook.refresh();
		assert.deepEqual(asked.map((entry) => entry.cwd), ["/a", "/a", "/b"], "B 的刷新拿了 A 在途的那一次");

		await act(async () => { asked[1].answer(); await Promise.resolve(); });
		assert.equal(view.find("output").textContent, "none", "A 晚到的回答落在了 B 上");

		await act(async () => { asked[2].answer(); await flight; });
		assert.equal(view.find("output").textContent, "/b");
	} finally { await view.unmount(); }
});

test("同一个仓库同时要两次，只问一次", async (t) => {
	const asked = fixture(t);
	const view = await mount(h(Probe, { cwd: "/a" }));
	try {
		const first = hook.refresh();
		const second = hook.refresh();
		assert.equal(first, second);
		assert.equal(asked.length, 1);
		await act(async () => { asked[0].answer(); await first; });
	} finally { await view.unmount(); }
});
