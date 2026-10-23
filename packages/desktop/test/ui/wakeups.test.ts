/**
 * 定时唤醒（`schedule_wakeup`、`cron_*`）在窗口里的三处：环境卡片「定时唤醒」那一节、标题栏按钮上的圆点、
 * 对话里到点那一行。
 *
 * 守的是：每一项写着说的是什么、什么时候触发、循环还是一次、何时过期，能取消（问主进程，以它推回来的表为准）；
 * 节底说明只活在这次运行里；没有就不画这一节；窗口刚开时问一次主进程；卡片收着时按钮上有圆点、关了那一节
 * 就不提醒；到点那一行是「定时唤醒 · 理由」，不是一个人发的气泡。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import type { SessionWakeup } from "@plume/core";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { DeliveryRow } from "../../src/features/conversation/DeliveryRow.tsx";
import { EnvironmentToggle } from "../../src/features/environment/EnvironmentToggle.tsx";
import { WakeupsSection } from "../../src/features/environment/WakeupsSection.tsx";
import { translate } from "../../src/i18n/translate.ts";
import { useApp } from "../../src/store/index.ts";
import { useEnvironmentCard } from "../../src/store/environment-card.ts";
import { setWakeups, useWakeups } from "../../src/store/session-wakeups.ts";
import { click, mount } from "../helpers/mount.ts";

const SESSION = "s-wake";
const soon = Date.now() + 10 * 60_000;
const ONCE: SessionWakeup = { id: "wake-1", kind: "wakeup", prompt: "看 CI 结果，过了就发版", reason: "等 #482 的 CI", recurring: false, createdAt: 1, nextAt: soon, fired: 0 };
const LOOP: SessionWakeup = { id: "cron-2", kind: "cron", prompt: "看部署进度\n完成了就删掉这个任务", cron: "*/5 * * * *", recurring: true, createdAt: 1, nextAt: soon + 60_000, expiresAt: soon + 3 * 86_400_000, fired: 2 };

let listed: string[];
let cancelled: { sessionId: string; id: string }[];
let answer: SessionWakeup[];

beforeEach(() => {
	listed = [];
	cancelled = [];
	answer = [ONCE, LOOP];
	localStorage.clear();
	useEnvironmentCard.setState({ open: false, hidden: [] });
	useWakeups.setState({ bySession: {} });
	Object.defineProperty(window, "plume", { configurable: true, value: {
		bootWindow: { id: "test", kind: "primary", sessionId: null, panelKind: null, panelScope: null },
		wakeups: {
			list: async (sessionId: string) => {
				listed.push(sessionId);
				return answer;
			},
			cancel: async (sessionId: string, id: string) => {
				cancelled.push({ sessionId, id });
				return true;
			},
		},
	} });
	useApp.setState({ activeSessionId: SESSION, toolRuns: {}, sessions: [], activity: {}, notices: [] });
});

afterEach(() => {
	Reflect.deleteProperty(window, "plume");
	useApp.setState({ activeSessionId: null, toolRuns: {}, sessions: [] });
	useWakeups.setState({ bySession: {} });
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(check(), `等不到：${what}`);
}

const scoped = (child: ReturnType<typeof h>) => h(SessionScope.Provider, { value: SESSION }, child);

test("那一节：每项写着说的是什么、何时触发、循环与否和过期；节底说明只在这次运行里有效", async () => {
	setWakeups(SESSION, [ONCE, LOOP]);
	const view = await mount(scoped(h(WakeupsSection, { sessionId: SESSION })));
	try {
		assert.ok(view.text().includes(translate("wakeups.title")));
		const rows = view.all("[data-ly-environment-wakeup]");
		assert.deepEqual(rows.map((row) => row.getAttribute("data-ly-environment-wakeup")), ["wake-1", "cron-2"]);
		assert.equal(rows[0]!.querySelector("[data-ly-wakeup-label]")?.textContent, "等 #482 的 CI", "唤醒写了理由用理由");
		assert.equal(rows[1]!.querySelector("[data-ly-wakeup-label]")?.textContent, "看部署进度", "cron 用 prompt 第一行");
		const once = rows[0]!.querySelector("[data-ly-wakeup-meta]")?.textContent ?? "";
		const loop = rows[1]!.querySelector("[data-ly-wakeup-meta]")?.textContent ?? "";
		assert.ok(once.includes(translate("wakeups.once")) && !once.includes(translate("wakeups.recurring")), once);
		assert.ok(loop.includes(translate("wakeups.recurring")), loop);
		assert.ok(loop.includes(translate("wakeups.expires", { time: "" }).trim()), "循环的写着过期");
		assert.ok(rows[1]!.querySelector("[data-ly-tip]")?.getAttribute("data-ly-tip")?.startsWith("*/5 * * * *\n"), "悬停读到 cron 表达式和完整 prompt");
		assert.equal(view.find("[data-ly-wakeups-note]").textContent, translate("wakeups.memoryOnly"));
	} finally {
		await view.unmount();
	}
});

test("取消：问主进程取消那一项；推回来的表里没了，那一行跟着下来，空了整节不画", async () => {
	setWakeups(SESSION, [ONCE]);
	const view = await mount(scoped(h(WakeupsSection, { sessionId: SESSION })));
	try {
		const cancel = view.find("[data-ly-wakeup-cancel]");
		assert.equal(cancel.getAttribute("aria-label"), translate("wakeups.cancel"));
		await click(cancel);
		await waitFor(() => cancelled.length === 1, "问主进程");
		assert.deepEqual(cancelled, [{ sessionId: SESSION, id: "wake-1" }]);
		setWakeups(SESSION, []);
		await waitFor(() => view.all("[data-ly-environment-section]").length === 0, "空了不画");
	} finally {
		await view.unmount();
	}
});

test("标题栏按钮：挂上时问一次主进程；有待触发的、卡片收着时挂圆点，开着卡片或关了那一节不挂", async () => {
	const view = await mount(scoped(h(EnvironmentToggle)));
	try {
		const dot = () => view.all("[data-ly-environment-dot]").length;
		await waitFor(() => listed.includes(SESSION) && dot() === 1, "问到表、挂上圆点");
		assert.ok(view.find("[data-ly-toolbar-button]").getAttribute("aria-label")?.includes(translate("environment.pendingWakeups", { n: 2 })));
		useEnvironmentCard.setState({ open: true });
		await waitFor(() => dot() === 0, "卡片开着");
		useEnvironmentCard.setState({ open: false, hidden: ["wakeups"] });
		await waitFor(() => dot() === 0, "那一节关了");
		useEnvironmentCard.setState({ hidden: [] });
		await waitFor(() => dot() === 1, "那一节放回来");
		setWakeups(SESSION, []);
		await waitFor(() => dot() === 0, "都触发或取消了");
	} finally {
		await view.unmount();
	}
});

test("到点那一行：「定时唤醒 · 理由」，不是一个人发的气泡；cron 的表达式在悬停里", async () => {
	const view = await mount(scoped(h(DeliveryRow, { delivery: [{ id: "cron-2", kind: "wakeup", agent: "", description: "看部署进度", status: "done", command: "*/5 * * * *" }] })));
	try {
		const row = view.find('[data-delivery-kind="wakeup"]');
		assert.ok(row.textContent?.includes(translate("wakeups.fired")));
		assert.ok(row.textContent?.includes("看部署进度"));
		assert.equal(row.querySelector("[data-ly-tip]")?.getAttribute("data-ly-tip"), "*/5 * * * *");
		assert.equal(view.all('[data-delivery-kind="agent"]').length, 0, "不当成子智能体的结果");
	} finally {
		await view.unmount();
	}
});
