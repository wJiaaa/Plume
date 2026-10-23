/**
 * 撤回或编辑重发时被截掉的那几轮改过文件，就先问：连文件一起退回，还是只动对话。
 *
 * 全有或全无：有一个文件不能安全写回，就只剩「只撤回对话」，按下去不带文件。没碰过文件的撤回照旧，
 * 最后一条直接撤，不弹框。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import type { RevertPlan } from "@plume/contract";
import type { Message, SessionMeta, UserContent, UserMessage as UserMessageType } from "@plume/core";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { UserMessage } from "../../src/features/conversation/UserMessage.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp, type AppState } from "../../src/store/index.ts";
import { click, fire, mount, type Mounted } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const meta: SessionMeta = { id: "a", title: "a", cwd: "/work/a", projectId: "a", projectName: "a", createdAt: 1, updatedAt: 2, modelId: "", messageCount: 2, seq: 3, usage };
const question: UserMessageType = { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 1 };
const said: Message[] = [question, { role: "assistant", content: [{ type: "text", text: "回答" }], api: "anthropic-messages", provider: "t", model: "t", usage, stopReason: "stop", timestamp: 2 }];

let plan: RevertPlan;
let reverted: Array<[string, number, { files?: boolean } | undefined]>;
let edited: Array<[string, number, string, boolean | undefined]>;
let previous: AppState;
let view: Mounted | undefined;

beforeEach(() => {
	reverted = [];
	edited = [];
	previous = useApp.getState();
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			agent: {
				revertPlan: async () => plan,
				revertMessage: async (sessionId: string, index: number, options?: { files?: boolean }) => {
					reverted.push([sessionId, index, options]);
				},
				editMessage: async (sessionId: string, index: number, content: UserContent[], options?: { files?: boolean }) => {
					const last = content.at(-1);
					edited.push([sessionId, index, last?.type === "text" ? last.text : "", options?.files]);
				},
			},
		},
	});
	useApp.setState({ activeSessionId: "a", pendingSessionId: null, meta, messages: said, toolRuns: {}, running: false, stopped: null, todos: [], hiccups: [], sessions: [meta], sessionCache: {}, workspace: { path: "/work/a" } as AppState["workspace"] });
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	useApp.setState(previous, true);
	Reflect.deleteProperty(window, "plume");
});

const settle = async (until: () => boolean) => {
	for (let i = 0; i < 100 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
const actions = () => [...document.body.querySelectorAll<HTMLButtonElement>("[data-ly-dialog-actions] button")];
const press = async (label: string) => {
	const button = actions().find((one) => one.textContent === label);
	assert.ok(button, `no 「${label}」 among ${actions().map((one) => one.textContent).join(" / ")}`);
	await click(button);
	// The answer runs once the exit has played, on `animationend` — a frame the DOM shim never draws.
	const card = document.body.querySelector(".ly-dialog-out");
	assert.ok(card, "pressing it did not close the question");
	await fire(card, new Event("animationend", { bubbles: true }));
	await settle(() => reverted.length > 0 || edited.length > 0);
};

async function undo() {
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionScope.Provider, { value: "a" }, h(UserMessage, { message: question, index: 0 })) }));
	await click(view.find("[data-message-undo]"));
	await settle(() => actions().length > 0 || reverted.length > 0);
}

test("files the cut turns changed can go back with the conversation, even from the last message", async () => {
	plan = { files: [{ path: "/work/a/src/a.ts", added: 3, removed: 1, problem: null }], unrecorded: false };
	await undo();
	assert.deepEqual(actions().map((one) => one.textContent), ["取消", "只撤回对话", "撤回对话和文件"]);
	assert.match(document.body.querySelector("[data-revert-file]")?.textContent ?? "", /src\/a\.ts\+3−1/);
	await press("撤回对话和文件");
	assert.deepEqual(reverted, [["a", 0, { files: true }]]);
});

test("the conversation alone is still a choice", async () => {
	plan = { files: [{ path: "/work/a/a.ts", added: 1, removed: 0, problem: null }], unrecorded: false };
	await undo();
	await press("只撤回对话");
	assert.deepEqual(reverted, [["a", 0, undefined]]);
});

test("one file that cannot go back safely leaves only the conversation, and says why", async () => {
	plan = { files: [{ path: "/work/a/a.ts", added: 1, removed: 0, problem: null }, { path: "/work/a/b.ts", added: 2, removed: 2, problem: "modified" }], unrecorded: false };
	await undo();
	assert.deepEqual(actions().map((one) => one.textContent), ["取消", "只撤回对话"]);
	assert.match(document.body.querySelectorAll("[data-revert-file]")[1]?.textContent ?? "", /之后被改过/);
	await press("只撤回对话");
	assert.deepEqual(reverted, [["a", 0, undefined]]);
});

test("no file touched: the last message goes back at once, as before", async () => {
	plan = { files: [], unrecorded: false };
	await undo();
	assert.equal(actions().length, 0);
	assert.deepEqual(reverted, [["a", 0, undefined]]);
});

async function edit(wording: string) {
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionScope.Provider, { value: "a" }, h(UserMessage, { message: question, index: 0 })) }));
	await click(view.find('button[aria-label="编辑并重新发送"]'));
	const field = view.find<HTMLTextAreaElement>("textarea");
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, wording);
	await fire(field, new Event("input", { bubbles: true }));
	await fire(field, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	await settle(() => actions().length > 0 || edited.length > 0);
}

test("an edit asks the same question, and resends with the files put back", async () => {
	plan = { files: [{ path: "/work/a/a.ts", added: 1, removed: 0, problem: null }], unrecorded: false };
	await edit("改过的问题");
	assert.deepEqual(actions().map((one) => one.textContent), ["取消", "只重新发送", "退回文件并发送"]);
	await press("退回文件并发送");
	assert.deepEqual(edited, [["a", 0, "改过的问题", true]]);
});

test("cancelling the question goes back to the editor with the wording kept", async () => {
	plan = { files: [{ path: "/work/a/a.ts", added: 1, removed: 0, problem: "modified" }], unrecorded: false };
	await edit("改了一半");
	assert.deepEqual(actions().map((one) => one.textContent), ["取消", "只重新发送"]);
	const cancel = actions().find((one) => one.textContent === "取消")!;
	await click(cancel);
	const card = document.body.querySelector(".ly-dialog-out");
	if (card) await fire(card, new Event("animationend", { bubbles: true }));
	await settle(() => !document.body.querySelector("[data-ly-dialog]"));
	assert.equal(edited.length, 0, "cancelled, yet it was sent");
	assert.equal(view!.find<HTMLTextAreaElement>("textarea").value, "改了一半");
});

test("an edit after turns that touched no file sends at once, as before", async () => {
	plan = { files: [], unrecorded: false };
	await edit("直接发");
	assert.equal(actions().length, 0);
	assert.deepEqual(edited, [["a", 0, "直接发", undefined]]);
});

test("only the last message can be edited; an earlier one says so instead of opening the editor", async () => {
	const later: UserMessageType = { role: "user", content: [{ type: "text", text: "后来的问题" }], timestamp: 3 };
	useApp.setState({ messages: [...said, later, { ...said[1], timestamp: 4 }] });
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionScope.Provider, { value: "a" }, h(UserMessage, { message: question, index: 0 })) }));
	const earlier = view.find<HTMLButtonElement>('button[aria-label="编辑并重新发送"]');
	assert.equal(earlier.disabled, true);
	assert.equal(earlier.getAttribute("data-ly-tip"), "只能编辑最后一条消息");
	await view.unmount();
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionScope.Provider, { value: "a" }, h(UserMessage, { message: later, index: 2 })) }));
	assert.equal(view.find<HTMLButtonElement>('button[aria-label="编辑并重新发送"]').disabled, false);
});
