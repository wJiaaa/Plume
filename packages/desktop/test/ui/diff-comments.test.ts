/** Git 评论只清除已经交出的快照，独立窗口不依赖本地输入框。 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h } from "react";
import type { SessionMeta } from "@plume/core";
import type { PlumeApi } from "@plume/contract";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { DiffCommentsProvider } from "../../src/features/git/DiffComments.tsx";
import { diffCommentPrompt, useDiffComments } from "../../src/features/git/diff-comments.ts";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { click, mount, type Mounted } from "../helpers/mount.ts";

const CWD = "/worktrees/selected";
const TARGET = "panel-session";
const comment = { path: "src/a.ts", lines: [{ type: "add" as const, newLine: 3, text: "next()" }], text: "这里要判空" };
type Prompt = Parameters<PlumeApi["agent"]["prompt"]>;

let requests: { args: Prompt; accept: () => void; reject: (cause: Error) => void }[];
let previous: { app: ReturnType<typeof useApp.getState>; comments: ReturnType<typeof useDiffComments.getState>; bridge: PropertyDescriptor | undefined };
let view: Mounted | undefined;

beforeEach(() => {
	previous = { app: useApp.getState(), comments: useDiffComments.getState(), bridge: Object.getOwnPropertyDescriptor(window, "plume") };
	requests = [];
	useApp.setState({ activeSessionId: "focused-elsewhere", workspace: { path: "/workspace/main", name: "main", isGitRepo: true, branch: "main" }, composerDraft: null, notices: [] });
	useDiffComments.setState({ byRepo: {} });
	useDiffComments.getState().save(CWD, comment);
	useDiffComments.getState().save("/other", { ...comment, text: "另一个仓库的意见" });
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	useApp.setState(previous.app, true);
	useDiffComments.setState(previous.comments, true);
	if (previous.bridge) Object.defineProperty(window, "plume", previous.bridge);
	else Reflect.deleteProperty(window, "plume");
});

async function screen(kind: "primary" | "panel", sessionId: string | null = TARGET): Promise<void> {
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			bootWindow: { kind, sessionId },
			agent: {
				prompt: (...args: Prompt) => new Promise<SessionMeta>((resolve, reject) => {
					requests.push({ args, accept: () => resolve({ id: args[0] } as SessionMeta), reject });
				}),
			},
			windows: {
				openInMain: () => { throw new Error("打开窗口不是消息交接确认"); },
			},
		},
	});
	view = await mount(h(I18nProvider, {
		locale: "zh-CN",
		children: h(SessionScope.Provider, { value: sessionId }, h(DiffCommentsProvider, { cwd: CWD, children: h("div", null, "diff") })),
	}));
}

const sendButton = () => view!.find<HTMLButtonElement>("[data-diff-comment-send]");
const saved = () => useDiffComments.getState().byRepo[CWD] ?? [];

test("普通窗口仍交给本屏输入框，提示词带所选工作树而不是当前会话目录", async () => {
	await screen("primary");
	const prompt = diffCommentPrompt(CWD, saved());
	await click(sendButton());
	assert.equal(requests.length, 0);
	const draft = useApp.getState().composerDraft;
	assert.ok(draft);
	assert.equal(draft.sessionId, TARGET);
	assert.equal(draft?.text, prompt);
	assert.ok(draft.text.includes(CWD));
	assert.ok(!draft.text.includes("/workspace/main"));
	assert.equal(draft?.send, true);
	assert.equal(saved().length, 0);
	assert.equal(useDiffComments.getState().byRepo["/other"]?.length, 1);
});

test("独立 Git 窗口按面板会话交给主进程，等接收确认才清空，不覆盖输入框草稿", async () => {
	useApp.getState().setComposerDraft("人写了一半的话", { sessionId: "focused-elsewhere" });
	const draft = useApp.getState().composerDraft;
	await screen("panel");
	const comments = saved();
	await click(sendButton());
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0]!.args, [TARGET, [{ type: "text", text: diffCommentPrompt(CWD, comments) }], { deliver: "followUp" }]);
	assert.equal(saved(), comments, "主进程尚未确认，评论必须留下");
	assert.equal(sendButton().disabled, true);
	await click(sendButton());
	assert.equal(requests.length, 1, "等确认时不能重复交一份");
	assert.equal(useApp.getState().composerDraft, draft);

	await act(async () => requests[0]!.accept());
	assert.equal(saved().length, 0);
	assert.equal(view!.all("[data-diff-comment-bar]").length, 0);
	assert.equal(useApp.getState().composerDraft, draft);
	assert.equal(useDiffComments.getState().byRepo["/other"]?.length, 1);
});

test("独立窗口交接失败保留评论并报错，重试成功后才清空", async () => {
	await screen("panel");
	const comments = saved();
	await click(sendButton());
	await act(async () => requests[0]!.reject(new Error("会话已关闭")));
	assert.equal(saved(), comments);
	assert.equal(sendButton().disabled, false);
	assert.equal(useApp.getState().composerDraft, null);
	assert.equal(useApp.getState().notices.at(-1)?.level, "error");
	assert.match(useApp.getState().notices.at(-1)?.message ?? "", /会话已关闭/);

	await click(sendButton());
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[1]!.args, requests[0]!.args);
	await act(async () => requests[1]!.accept());
	assert.equal(saved().length, 0);
});

test("等确认期间新增或改过的评论不会被旧发送清掉", async () => {
	useDiffComments.getState().save(CWD, { ...comment, path: "src/b.ts", text: "一起发出的另一条" });
	await screen("panel");
	const original = saved()[0]!;
	await click(sendButton());
	await act(async () => {
		useDiffComments.getState().save(CWD, { ...original, text: "确认期间改过的意见" });
		useDiffComments.getState().save(CWD, { ...comment, path: "src/c.ts", text: "确认期间新增的意见" });
	});
	await act(async () => requests[0]!.accept());
	assert.deepEqual(saved().map((one) => one.text), ["确认期间改过的意见", "确认期间新增的意见"]);
});

test("还没有目标会话的独立窗口不借用其他会话，也不吞评论", async () => {
	await screen("panel", null);
	assert.equal(sendButton().disabled, true);
	await click(sendButton());
	assert.equal(requests.length, 0);
	assert.equal(useApp.getState().composerDraft, null);
	assert.equal(saved().length, 1);
});
