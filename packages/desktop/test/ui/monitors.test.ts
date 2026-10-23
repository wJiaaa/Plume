/**
 * 在跑的 `monitor` 在窗口里的两处：环境卡片「后台任务」那一行的「监视」标记，标题栏按钮上的圆点。
 *
 * 守的是：monitor 和普通后台命令认得出来（它每送一批输出就是一轮）；卡片收着时它让按钮亮点，普通后台命令
 * 不亮——开着一个 dev server 是常态；窗口刚开时问一次主进程，之后跟着 `monitors` 事件走。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import type { SessionServices } from "@plume/contract";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { EnvironmentToggle } from "../../src/features/environment/EnvironmentToggle.tsx";
import { JobsSection } from "../../src/features/environment/JobsSection.tsx";
import { translate } from "../../src/i18n/translate.ts";
import { useApp } from "../../src/store/index.ts";
import { useEnvironmentCard } from "../../src/store/environment-card.ts";
import { setMonitors, useMonitors } from "../../src/store/session-monitors.ts";
import { useWakeups } from "../../src/store/session-wakeups.ts";
import { mount } from "../helpers/mount.ts";

const SESSION = "s-watch";
const job = (id: string, command: string, kind?: "monitor"): SessionServices["jobs"][number] => ({
	id,
	command,
	startedAt: 1,
	exitCode: null,
	status: "running",
	endpoints: [],
	...(kind ? { kind } : {}),
});

let answer: SessionServices;

beforeEach(() => {
	answer = { jobs: [job("dev", "pnpm dev"), job("watch", "tail -f build.log | grep error", "monitor")] };
	localStorage.clear();
	useEnvironmentCard.setState({ open: false, hidden: [] });
	useMonitors.setState({ bySession: {} });
	useWakeups.setState({ bySession: {} });
	Object.defineProperty(window, "plume", { configurable: true, value: {
		bootWindow: { id: "test", kind: "primary", sessionId: null, panelKind: null, panelScope: null },
		services: { list: async () => answer, stop: async () => true },
		wakeups: { list: async () => [], cancel: async () => true },
	} });
	useApp.setState({ activeSessionId: SESSION, toolRuns: {}, sessions: [], activity: {}, notices: [] });
});

afterEach(() => {
	Reflect.deleteProperty(window, "plume");
	useApp.setState({ activeSessionId: null, toolRuns: {}, sessions: [] });
	useMonitors.setState({ bySession: {} });
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(check(), `等不到：${what}`);
}

const scoped = (child: ReturnType<typeof h>) => h(SessionScope.Provider, { value: SESSION }, child);

test("后台任务那一节：monitor 那行带「监视」，悬停先说它会叫醒 agent；普通命令不带", async () => {
	const view = await mount(scoped(h(JobsSection, { sessionId: SESSION })));
	try {
		await waitFor(() => view.all("[data-ly-environment-job]").length === 2, "两行");
		const [dev, watch] = view.all("[data-ly-environment-job]");
		assert.equal(dev!.querySelector("[data-ly-environment-monitor]"), null);
		assert.equal(dev!.querySelector("[data-ly-tip]")?.getAttribute("data-ly-tip"), "pnpm dev");
		assert.equal(watch!.querySelector("[data-ly-environment-monitor]")?.textContent, translate("environment.monitorTag"));
		assert.equal(watch!.querySelector("[data-ly-tip]")?.getAttribute("data-ly-tip"), `${translate("environment.monitorTip")}\ntail -f build.log | grep error`);
	} finally {
		await view.unmount();
	}
});

test("标题栏按钮：挂上时问一次；有 monitor 在跑、卡片收着时亮点，事件说没了就灭；只有普通命令不亮", async () => {
	const view = await mount(scoped(h(EnvironmentToggle)));
	try {
		const dot = () => view.all("[data-ly-environment-dot]").length;
		await waitFor(() => dot() === 1, "问到一个 monitor、亮点");
		assert.ok(view.find("[data-ly-toolbar-button]").getAttribute("aria-label")?.includes(translate("environment.runningMonitors", { n: 1 })));
		useEnvironmentCard.setState({ open: true });
		await waitFor(() => dot() === 0, "卡片开着");
		useEnvironmentCard.setState({ open: false, hidden: ["jobs"] });
		await waitFor(() => dot() === 0, "那一节关了");
		useEnvironmentCard.setState({ hidden: [] });
		await waitFor(() => dot() === 1, "那一节放回来");
		setMonitors(SESSION, 0);
		await waitFor(() => dot() === 0, "monitor 停了，dev server 还在跑也不亮");
	} finally {
		await view.unmount();
	}
});
