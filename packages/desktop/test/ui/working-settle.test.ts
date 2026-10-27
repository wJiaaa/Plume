/**
 * 最后一个子智能体交差、送达还没开出下一轮的那一下，`useScopedWorking` 仍说在干。
 *
 * core 把结果攒 400ms 再开一轮，这段空档里主回合和名册都是空闲的。交付卡片从前就在这一下挂上、
 * 主会话接着跑时又卸下，真窗口里量到「挂上、卸下、挂上」三次。这里测那段余量：交差当帧不放开、
 * 到时自己放开、换到另一个会话不借这段余量。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, createElement as h } from "react";
import type { SubAgentSummary } from "@plume/core";
import { SessionScope, useScopedWorking } from "../../src/app/session-scope.tsx";
import { useApp, type AppState } from "../../src/store/index.ts";
import { useSubAgents } from "../../src/store/subAgents.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

function agent(status: SubAgentSummary["status"]): SubAgentSummary {
	return { id: "d1", agent: "general", description: "核对", status, startedAt: 1, toolCalls: 0 } as SubAgentSummary;
}

function Probe() {
	return h("output", null, String(useScopedWorking()));
}

function screen(id: string): Promise<Mounted> {
	return mount(h(SessionScope.Provider, { value: id }, h(Probe)));
}

let previous: AppState;
let view: Mounted | undefined;

beforeEach(() => {
	previous = useApp.getState();
	useApp.setState({ activeSessionId: "a", running: false, activity: {} });
	useSubAgents.setState({ rosters: { a: [agent("running")] } });
	mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(async () => {
	mock.timers.reset();
	await view?.unmount();
	view = undefined;
	useSubAgents.setState({ rosters: {} });
	useApp.setState(previous, true);
});

test("子智能体交差的那一刻仍算在干，过了送达的空档才放开", async () => {
	view = await screen("a");
	assert.equal(view.host.textContent, "true");

	await act(async () => useSubAgents.setState({ rosters: { a: [agent("done")] } }));
	assert.equal(view.host.textContent, "true", "交差当帧就放开，交付卡片会在送达开轮前闪出来");

	await act(async () => mock.timers.tick(999));
	assert.equal(view.host.textContent, "true");
	await act(async () => mock.timers.tick(1));
	assert.equal(view.host.textContent, "false", "没有送达开轮时不能一直卡在「在干」");
});

test("换到另一个会话不借上一个会话的余量", async () => {
	useSubAgents.setState({ rosters: { a: [agent("running")], b: [] } });
	view = await screen("a");
	assert.equal(view.host.textContent, "true");
	// 同一棵树换会话（切屏时就是这样），状态留着；乙没派过子智能体，不该被当成「刚交差」。
	await view.rerender(h(SessionScope.Provider, { value: "b" }, h(Probe)));
	assert.equal(view.host.textContent, "false");
});
