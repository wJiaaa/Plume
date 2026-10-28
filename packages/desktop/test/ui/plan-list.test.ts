import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { Message } from "@plume/core";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { PlanPanel } from "../../src/features/dock/panels/PlanPanel.tsx";
import { PlansSection } from "../../src/features/environment/PlansSection.tsx";
import { translate } from "../../src/i18n/translate.ts";
import { useApp } from "../../src/store/index.ts";
import { usePlanReview } from "../../src/store/plan-review.ts";
import { provideScope, usePaneDock } from "../../src/features/dock/index.ts";
import { click, mount } from "../helpers/mount.ts";

// 菜单画在 portal 里，不在挂载的那棵树下面。
const options = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

const call = (id: string, plan: string) =>
	({ role: "assistant", content: [{ type: "toolCall", id, name: "submit_plan", arguments: { plan } }], timestamp: 1 }) as unknown as Message;
const result = (id: string, details: unknown) =>
	({ role: "toolResult", toolCallId: id, toolName: "submit_plan", content: [], isError: false, details, timestamp: 1 }) as Message;

const REDISSON = "# 移除 Redisson\n\n换成 Spring Data Redis。";
const PLATFORM = "# 中台一期\n\n租户接入、设备注册。";
// 一份打回、两份批准且都交给了新会话，最后还压缩过一次：快照里是后一份。
const HISTORY: Message[] = [
	call("a", "# 草稿\n\n太粗。"), result("a", { kind: "plan-feedback", feedback: "再细一点" }),
	call("b", REDISSON), result("b", { kind: "plan", plan: { plan: REDISSON, handoff: true, approvedAt: 1_000 } }),
	call("c", PLATFORM), result("c", { kind: "plan", plan: { plan: PLATFORM, handoff: true, approvedAt: 2_000 } }),
	{ role: "user", synthetic: true, content: [], timestamp: 3, compactionContext: { plan: { plan: PLATFORM, handoff: true, approvedAt: 2_000 } } } as unknown as Message,
];

function setup() {
	const previous = useApp.getState();
	const opened: string[] = [];
	const open = usePaneDock.getState().open;
	provideScope(() => "owner");
	usePaneDock.setState({ open: (_scope: string, kind: string) => { opened.push(kind); return true; } });
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({ activeSessionId: "owner", approvals: [], messages: HISTORY });
	usePlanReview.setState({ reviews: {}, viewing: {} });
	return { opened, restore: () => { provideScope(() => null); usePaneDock.setState({ open }); useApp.setState(previous, true); usePlanReview.setState({ reviews: {}, viewing: {} }); } };
}

test("一个会话批准过两份计划，面板能切到先前那一份，打回的不列", async () => {
	const env = setup();
	const view = await mount(h(LayoutProvider, { children: h(PlanPanel) }));
	try {
		assert.match(view.find("[data-plan-body]").textContent ?? "", /中台一期/, "默认摊开最后那份");
		assert.equal(view.find("[data-plan-status]").textContent, translate("plan.approved"));
		assert.equal(view.find("[data-plan-switch]").textContent, translate("plan.approvedCount", { n: 2 }));

		await click(view.find("[data-plan-switch]"));
		// 标题在前、批准时间和「已交给新会话」在第二行；快照里那份不重复列，打回的草稿不列。
		assert.deepEqual(options().map((option) => option.textContent?.startsWith("移除 Redisson") ? "移除 Redisson" : option.textContent?.startsWith("中台一期") ? "中台一期" : option.textContent), ["移除 Redisson", "中台一期"]);
		assert.ok(options().every((option) => option.textContent?.includes(translate("plan.handedOff"))));
		await click(options()[0]!);
		assert.match(view.find("[data-plan-body]").textContent ?? "", /移除 Redisson/);
		assert.equal(options().length, 0, "挑完菜单收起");
	} finally { await view.unmount(); env.restore(); }
});

test("只批准过一份时不给切换", async () => {
	const env = setup();
	useApp.setState({ messages: HISTORY.slice(0, 4) });
	const view = await mount(h(LayoutProvider, { children: h(PlanPanel) }));
	try {
		assert.match(view.find("[data-plan-body]").textContent ?? "", /移除 Redisson/);
		assert.equal(view.all("[data-plan-switch]").length, 0);
	} finally { await view.unmount(); env.restore(); }
});

test("环境卡片的「计划」一节列出批准过的每一份，点一行在计划面板里摊开那一份", async () => {
	const env = setup();
	const view = await mount(h(LayoutProvider, { children: h(PlansSection, { sessionId: "owner" }) }));
	try {
		const rows = view.all("[data-ly-environment-plan]");
		assert.deepEqual(rows.map((row) => row.getAttribute("data-ly-environment-plan")), ["1000", "2000"]);
		assert.match(rows[0]!.textContent ?? "", /移除 Redisson/);
		await click(rows[0]!);
		assert.equal(usePlanReview.getState().viewing.owner, 1_000);
		assert.deepEqual(env.opened, ["plan"]);

		await act(async () => { useApp.setState({ messages: HISTORY.slice(0, 2) }); });
		assert.equal(view.all("[data-ly-environment-section]").length, 0, "一份都没批准过，整节不画");
	} finally { await view.unmount(); env.restore(); }
});
