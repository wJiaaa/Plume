/**
 * 侧栏两百行时，一行什么时候该重画。
 *
 * 计数靠每一行渲染时都会读一次的 `activity[id]`：把 `activity` 换成一个记录读取的代理，
 * 读了几次就是这一行渲染了几次（store 在测试期间不变，selector 只在渲染时跑）。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { act, createElement as h, useState } from "react";
import { DEFAULT_SETTINGS, type SessionMeta, type Settings } from "@plume/core";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { useApp } from "../../src/store/index.ts";
import { groupSessions, nestSpawned } from "../../src/lib/sidebar-grouping.ts";
import { ProjectList } from "../../src/features/sidebar/ProjectList.tsx";
import type { RowActions } from "../../src/features/sidebar/SessionRow.tsx";
import { fire, mount } from "../helpers/mount.ts";

const ROWS = 200;
const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };
const sessions: SessionMeta[] = Array.from({ length: ROWS }, (_, index) => ({
	id: `s${index}`, title: `s${index}`, cwd: "/a", projectId: "a", projectName: "A", project: "a",
	createdAt: 1, updatedAt: ROWS - index, modelId: "", messageCount: 1, seq: 2, usage,
}));
const projects = [{ id: "a", path: "/a", name: "A", lastOpenedAt: 0 }];
const actions: RowActions = { onOpen: () => {}, onArchive: () => {} };
let reads = 0;

beforeEach(() => {
	reads = 0;
	const activity = new Proxy({}, { get: (_target, key) => { if (typeof key === "string" && key.startsWith("s")) reads++; return undefined; } });
	useApp.setState({ settings: { ...DEFAULT_SETTINGS, projects }, sessions, activity, notices: [], activeSessionId: null });
	Object.defineProperty(window, "plume", { configurable: true, value: {
		settings: { save: async (next: Settings) => next },
		workspace: { info: async (path: string) => ({ path, name: "A", isGitRepo: false, branch: null }) },
	} });
});

const groups = nestSpawned(groupSessions(sessions, projects, ""));
let bump: () => void = () => {};
const onReordered = () => {};

function Harness() {
	const [tick, setTick] = useState(0);
	bump = () => setTick((value) => value + 1);
	return h(ProjectList, {
		groups,
		collapsed: [],
		onToggleCollapsed: () => {},
		groupProps: () => ({ collapsed: false, onToggleCollapsed: () => {}, shown: ROWS, onShowMore: () => {}, onCollapse: () => {}, actions }),
		actions,
		onReordered,
		sort: "updatedAt",
		empty: h("p", null, `empty ${tick}`),
		listSettings: null,
		onNewLooseChat: () => {},
	});
}
const view = () => mount(h(LayoutProvider, null, h(Harness)));
const pointer = (type: string, y: number) => new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 20, clientY: y });

test("父组件同样的 props 重渲染一次，两百行一行都不重画", async () => {
	const mounted = await view();
	try {
		assert.equal(mounted.all("[data-ly-row]").length, ROWS);
		const before = reads;
		await act(async () => bump());
		assert.equal(reads - before, 0);
	} finally { await mounted.unmount(); }
});

test("拖着走 20 次 pointermove，行渲染次数不随移动次数增长", async () => {
	const mounted = await view();
	const mountReads = reads;
	try {
		const source = mounted.find('[data-ly-row="s0"] > button');
		await fire(source, pointer("pointerdown", 0));
		await fire(source, pointer("pointermove", 20));
		// 同一行里来回移动：落点不变，没有一行该重画。
		let before = reads;
		for (let step = 0; step < 20; step++) await fire(mounted.find('[data-ly-row="s5"]'), pointer("pointermove", 30 + step));
		const inPlace = reads - before;
		// 跨过 20 行：每换一次落点，只有失去它和得到它的那两行重画。
		before = reads;
		for (let step = 0; step < 20; step++) await fire(mounted.find(`[data-ly-row="s${10 + step}"]`), pointer("pointermove", 60 + step));
		const across = reads - before;
		console.log(`同一行内 20 次移动读了 ${inPlace} 次，跨 20 行读了 ${across} 次（挂载时每行 ${mountReads / ROWS} 次）`);
		// 读取次数是渲染次数的常数倍；整列重画一遍就是 ROWS 的量级，从前每一次移动都是一遍。
		assert.ok(inPlace < ROWS / 20, `同一行里移动不该重画列表，读了 ${inPlace} 次`);
		assert.ok(across < ROWS, `跨行只该重画进出落点的两行，读了 ${across} 次`);
		await fire(source, pointer("pointerup", 80));
	} finally { await mounted.unmount(); }
});
