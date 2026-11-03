/**
 * 命令页、钩子页换了项目：上一个范围晚到的回答不能落在新范围下面。
 *
 * 从前 `.then(setList)` 不问这份回答是哪个目录的，用户级读得慢一点，切到项目以后它回来，
 * 页面就把用户级的列表写在项目的名字下面。
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, createElement as h } from "react";
import { DEFAULT_SETTINGS } from "@plume/core";
import type { HooksView, PlumeApi } from "@plume/contract";
import { CommandsSettings } from "../../src/features/settings/CommandsSettings.tsx";
import { HooksSettings } from "../../src/features/settings/HooksSettings.tsx";
import { useApp } from "../../src/store/index.ts";
import { click, mount, type Mounted } from "../helpers/mount.ts";

type CommandList = Awaited<ReturnType<PlumeApi["commands"]["list"]>>;
const PROJECT = { id: "p", path: "/work/p", name: "p-app", lastOpenedAt: 0 };

/** Every request by directory, answered only when the test says so. */
function deferred<T>() {
	const asked: { cwd: string | null; resolve: (value: T) => void; reject: (reason: Error) => void }[] = [];
	const call = (cwd: string | null) => new Promise<T>((resolve, reject) => asked.push({ cwd, resolve, reject }));
	return { asked, call };
}

function bridge(t: TestContext, plume: object) {
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	Object.defineProperty(window, "plume", { configurable: true, value: plume });
	useApp.setState({ settings: { ...DEFAULT_SETTINGS, projects: [PROJECT] }, workspace: null });
	t.after(() => { if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume"); });
}

async function pickProject(view: Mounted) {
	await click(view.find("[data-ly-project-scope]"));
	const item = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((element) => element.textContent?.includes("p-app"));
	assert.ok(item, "范围菜单里没有那个项目");
	await click(item);
}

// 两个范围的命令都写成 workspace：页面只画当前范围的那一种，这样用户级的那份一旦落地就看得见。
const commands = (name: string): CommandList => ({
	commands: [{ name, description: name, content: "…", path: `/x/${name}.md`, scope: "workspace", origin: "plume" }],
	builtins: [], diagnostics: [], skills: [],
});

test("命令页：切到项目以后，用户级晚到的列表不落地", async (t) => {
	const list = deferred<CommandList>();
	bridge(t, { commands: { list: list.call } });
	const view = await mount(h(CommandsSettings));
	try {
		await pickProject(view);
		assert.deepEqual(list.asked.map((entry) => entry.cwd), ["", PROJECT.path]);
		await act(async () => { list.asked[1].resolve(commands("project-only")); });
		await act(async () => { list.asked[0].resolve(commands("user-only")); });
		assert.match(view.text(), /project-only/);
		assert.doesNotMatch(view.text(), /user-only/, "用户级的列表写在了项目下面");
	} finally { await view.unmount(); }
});

test("钩子页：切到项目以后，用户级晚到的错误不挂在项目下面", async (t) => {
	const list = deferred<HooksView>();
	bridge(t, { hooks: { list: list.call } });
	const view = await mount(h(HooksSettings));
	try {
		await pickProject(view);
		assert.deepEqual(list.asked.map((entry) => entry.cwd), [null, PROJECT.path]);
		await act(async () => { list.asked[1].resolve({ user: [], project: [] }); });
		await act(async () => { list.asked[0].reject(new Error("用户级读不出来")); });
		assert.doesNotMatch(view.text(), /用户级读不出来/);
	} finally { await view.unmount(); }
});
