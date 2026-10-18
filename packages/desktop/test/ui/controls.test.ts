/**
 * The controls every settings page is built out of.
 *
 * They live under `components/settings/` today and are already imported from outside it, which is
 * why the plan moves them to `ui/`. These tests are what makes that move safe: they describe the
 * behaviour callers depend on, and they will run unchanged from the new location.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";

import { Badge, Notice, Segmented, Toggle } from "../../src/features/settings/controls.tsx";
import { TriangleAlert } from "../../src/ui/icons/index.ts";
import { click, mount } from "../helpers/mount.ts";

test("Toggle: 是 switch 角色，状态走 aria-checked 而不是靠颜色", async () => {
	const view = await mount(h(Toggle, { checked: false, onChange: () => {} }));
	const button = view.find("button");

	// 读屏软件只读得到 role 和 aria-checked；轨道的颜色对它不存在。
	assert.equal(button.getAttribute("role"), "switch");
	assert.equal(button.getAttribute("aria-checked"), "false");
	assert.equal(button.getAttribute("type"), "button");

	await view.rerender(h(Toggle, { checked: true, onChange: () => {} }));
	assert.equal(view.find("button").getAttribute("aria-checked"), "true");

	await view.unmount();
});

test("Toggle: 点击把当前值取反送出，自己不持有状态", async () => {
	const seen: boolean[] = [];
	const view = await mount(h(Toggle, { checked: false, onChange: (next: boolean) => seen.push(next) }));
	await click(view.find("button"));
	assert.deepEqual(seen, [true]);

	// 受控组件：没有人改 props，再点一次送出的仍然是 !checked。
	await click(view.find("button"));
	assert.deepEqual(seen, [true, true]);

	await view.unmount();
});

test("Segmented: 每个选项一个按钮，点击送出该选项的值", async () => {
	const options = [
		{ value: "system", label: "跟随系统" },
		{ value: "light", label: "浅色" },
		{ value: "dark", label: "深色" },
	];
	let picked: string | null = null;
	const view = await mount(h(Segmented, { value: "system", options, onChange: (v: string) => (picked = v) }));

	const buttons = view.all<HTMLButtonElement>("button");
	assert.equal(buttons.length, 3);
	assert.deepEqual(
		buttons.map((b) => b.textContent),
		["跟随系统", "浅色", "深色"],
	);

	await click(buttons[2]!);
	assert.equal(picked, "dark");

	await view.unmount();
});

/*
 * 实底从按钮身上搬到了一块共用的、会滑过去的底上，所以这条跟着改了要检查的东西。
 *
 * 原来的写法是「选中那颗按钮的类名里有 bg-elevated」，那是在描述实现：底一旦不再属于某一颗按
 * 钮，断言就红了，而画面上什么也没变差。要守的其实是它的名字说的那件事——两颗按钮画得不一样，
 * 且有一块实底落在选中的那颗上。顺带补上 `aria-pressed`：现在类名不再是「唯一的状态提示」，
 * 读屏也能知道哪个是开着的。
 */
test("Segmented: 选中项与其余可区分，且实底落在选中的那颗上", async () => {
	const options = [
		{ value: "a", label: "甲" },
		{ value: "b", label: "乙" },
	];
	const view = await mount(h(Segmented, { value: "b", options, onChange: () => {} }));
	const [first, second] = view.all<HTMLButtonElement>("button");

	assert.notEqual(first!.className, second!.className, "选中与未选中必须画得不一样");
	assert.equal(second!.getAttribute("aria-pressed"), "true");
	assert.equal(first!.getAttribute("aria-pressed"), "false");
	assert.match(view.find("[aria-hidden]").className, /bg-elevated/, "实底还在，只是现在它会滑");

	await view.unmount();
});

test("Badge: 四种语气各自成立，内容原样渲染", async () => {
	for (const tone of ["ok", "muted", "danger", "accent"] as const) {
		// children 是必填的，所以第三个参数不能省——这一条是 tsc 在纳入 test/ui 之后立刻抓到的。
		const view = await mount(h(Badge, { tone, children: "已安装" }));
		assert.equal(view.text(), "已安装");
		await view.unmount();
	}
});

test("Notice: 框和色调由组件出，普通档的字色留给调用方", async () => {
	const danger = await mount(h(Notice, { tone: "danger", role: "alert" }, "保存失败"));
	const box = danger.find("[role=alert]");
	assert.match(box.className, /\brounded-lg\b/);
	assert.match(box.className, /\btext-danger\b/);
	assert.equal(box.querySelector("svg"), null);
	await danger.unmount();

	const muted = await mount(h(Notice, { tone: "muted", icon: TriangleAlert, className: "text-ink-faint" }, "两条警告"));
	const quiet = muted.find("div");
	assert.match(quiet.className, /\bborder-line\b/);
	// 字色只有调用方给的那一个，组件不再塞第二个进来和它抢。
	assert.deepEqual(quiet.className.match(/\btext-ink-[a-z]+/g), ["text-ink-faint"]);
	assert.match(quiet.querySelector("svg")?.getAttribute("class") ?? "", /\btext-ink-muted\b/);
	await muted.unmount();
});
