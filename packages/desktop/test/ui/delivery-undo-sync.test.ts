/**
 * An undo made on one surface of a turn reaches every other surface showing that turn.
 *
 * Undo writes the file back and leaves the turn's record alone, so the rows and their +N −M stay as
 * they were; what changes is whether each file can still be undone. The card read that once, on
 * mount: an undo made in the review beside it left the card offering 「撤销」 for the whole turn, and
 * the main process refused it. A popped-out pane is another renderer and heard nothing of an undo
 * made on the card. Now the main process pushes the turn's new state to every window after an undo.
 * These mount the card and the pane the way a screen and a panel window do, and stand in for another
 * window's undo with the push it causes here.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h, Fragment, type ReactNode } from "react";
import type { Message, SessionMeta } from "@plume/core";
import type { TurnDelivery, WorkspaceInfo } from "@plume/contract";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { DockScope, SessionScope } from "../../src/app/session-scope.tsx";
import { TurnDeliveryCard } from "../../src/features/conversation/TurnDelivery.tsx";
import { clearDeliveryCache } from "../../src/features/conversation/delivery-cache.ts";
import { useDeliveryReview } from "../../src/features/conversation/delivery-review.ts";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import "../../src/app/panels.tsx";
import { allPanels } from "../../src/features/dock/panels/registry.ts";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp, type AppState } from "../../src/store/index.ts";
import { click, mount, type Mounted } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const ALPHA: WorkspaceInfo = { path: "/work/alpha", name: "alpha-app", isGitRepo: true, branch: "main" };
const TURN = 2;
const APP = "/work/alpha/src/app.ts";
const LIB = "/work/alpha/src/lib.ts";

const A: SessionMeta = { id: "a", title: "a", cwd: ALPHA.path, projectId: ALPHA.path, projectName: ALPHA.name, createdAt: 1, updatedAt: 2, modelId: "", messageCount: 2, seq: 3, usage };
const said: Message[] = [
	{ role: "user", content: [{ type: "text", text: "改两个文件" }], timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "改好了" }], api: "anthropic-messages", provider: "t", model: "t", usage, stopReason: "stop", timestamp: TURN },
];

/** What the main process holds: whether each of the turn's files can still be undone. */
let undoable: Record<string, boolean>;
let reads: number;
/** Holds a read until the test lets it answer, with the state it was asked in. */
let held: Array<() => void> | null;
/** This window's `delivery:changed` listeners. */
let listeners: Set<(change: { sessionId: string; timestamp: number; delivery: TurnDelivery }) => void>;

function delivery(): TurnDelivery {
	return {
		files: [APP, LIB].map((path) => ({ path, added: 3, removed: 1, hunks: [], canUndo: undoable[path] })),
		commands: [],
		serviceJobIds: [],
		warnings: [],
		reportPath: null,
	};
}

let previous: { app: AppState; review: ReturnType<typeof useDeliveryReview.getState> };
let view: Mounted | undefined;

beforeEach(() => {
	undoable = { [APP]: true, [LIB]: true };
	reads = 0;
	held = null;
	listeners = new Set();
	previous = { app: useApp.getState(), review: useDeliveryReview.getState() };
	clearDeliveryCache();
	localStorage.clear();
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			delivery: {
				get: async () => {
					reads++;
					const value = delivery();
					if (held) await new Promise<void>((resolve) => held!.push(resolve));
					return value;
				},
				undo: async (sessionId: string, timestamp: number, path?: string) => {
					for (const one of path ? [path] : Object.keys(undoable)) undoable[one] = false;
					const value = delivery();
					// The main process tells every window, this one included.
					for (const listener of listeners) listener({ sessionId, timestamp, delivery: value });
					return value;
				},
				onChanged: (listener: (change: { sessionId: string; timestamp: number; delivery: TurnDelivery }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		},
	});
	useApp.setState({
		activeSessionId: "a", pendingSessionId: null, meta: A, messages: said, toolRuns: {}, running: false,
		workspace: ALPHA, scratchCwd: null, scratchRoots: ["/scratch"], parkedDraft: null,
		sessions: [A], sessionCache: {}, workspaceByPath: {},
		notify: () => {},
	});
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, host: null });
	usePaneDock.getState().rememberSize("a", { width: 1200, height: 900 });
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	useApp.setState(previous.app, true);
	useDeliveryReview.setState(previous.review, true);
	localStorage.clear();
	Reflect.deleteProperty(window, "plume");
});

const panel = allPanels().find((one) => one.kind === "delivery")!;
const DeliveryPanel = panel.render;

/** A screen of conversation 甲: its transcript's card and its dock's review, side by side. */
function screen(...body: ReactNode[]): Promise<Mounted> {
	return mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(DockScope.Provider, { value: "a" }, h(SessionScope.Provider, { value: "a" }, h(Fragment, null, ...body))) }) }));
}

/** What a panel window renders: the conversation's scope, no dock scope, and the pane's own header. */
function panelWindow(): Promise<Mounted> {
	return mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(SessionScope.Provider, { value: "a" }, h(panel.header!), h(DeliveryPanel)) }) }));
}

async function settle(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}

/** The card offers undoing the whole turn — which the main process refuses once any file of it is past undoing. */
const offersUndo = () => Boolean(document.querySelector('[data-turn-delivery] button[data-ly-tip="撤销这次文件改动"]'));

/** A file's undo in the pane, which disables itself once that file is past undoing. */
function paneUndo(path: string): HTMLButtonElement {
	const button = document.querySelector<HTMLButtonElement>(`[data-delivery-diff="${path}"] button[aria-label]`);
	assert.ok(button, `the pane shows ${path}`);
	return button;
}

/** Answer the confirm dialog, and play the exit animation the dialog waits for before acting. */
async function confirm(): Promise<void> {
	const yes = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "撤销改动");
	assert.ok(yes, "the undo asks first");
	await click(yes);
	await act(async () => {
		document.querySelector(".ly-dialog-out")?.dispatchEvent(new Event("animationend", { bubbles: true }));
	});
	await settle();
}

/** A window's review of the turn: what 「审核」 or a file row does. */
async function review(path: string | null): Promise<void> {
	await act(async () => {
		useDeliveryReview.getState().open({ sessionId: "a", timestamp: TURN, path });
	});
	await settle();
}

/** Another window's undo, as this one hears it: the main process's push. */
async function undoneElsewhere(sessionId: string, timestamp: number): Promise<void> {
	await act(async () => {
		for (const listener of listeners) listener({ sessionId, timestamp, delivery: delivery() });
	});
	await settle();
}

test("an undo in the review beside the card reaches the card, with no read after it", async () => {
	view = await screen(h(TurnDeliveryCard, { timestamp: TURN }), h(DeliveryPanel));
	await settle();
	await review(APP);
	assert.ok(offersUndo(), "every file can be undone yet");
	const before = reads;
	await click(paneUndo(APP));
	await confirm();
	assert.equal(paneUndo(APP).disabled, true, "the pane took its own undo");
	assert.ok(!offersUndo(), "the card went on offering 「撤销」 for the whole turn after the review undid one of its files");
	assert.equal(reads - before, 0, "the undo answers with the turn's new state: nothing reads it again");
});

test("an undo on the card reaches the review beside it", async () => {
	view = await screen(h(TurnDeliveryCard, { timestamp: TURN }), h(DeliveryPanel));
	await settle();
	await review(null);
	const before = reads;
	await click(document.querySelector('[data-turn-delivery] button[data-ly-tip="撤销这次文件改动"]')!);
	await confirm();
	assert.equal(paneUndo(APP).disabled, true);
	assert.equal(paneUndo(LIB).disabled, true);
	assert.equal(reads - before, 0);
});

test("an undo made in another window reaches the card", async () => {
	view = await screen(h(TurnDeliveryCard, { timestamp: TURN }));
	await settle();
	assert.ok(offersUndo());
	undoable[APP] = false;
	const before = reads;
	await undoneElsewhere("a", TURN);
	assert.ok(!offersUndo(), "an undo made in the popped-out pane left this window's card offering 「撤销」");
	assert.equal(reads - before, 0);
});

test("an undo made on the card in another window reaches a popped-out pane", async () => {
	useDeliveryReview.getState().open({ sessionId: "a", timestamp: TURN, path: null });
	// The main window's store; the panel window has only the shared record.
	useDeliveryReview.setState({ reviews: {} });
	view = await panelWindow();
	await settle();
	assert.equal(paneUndo(LIB).disabled, false);
	undoable[LIB] = false;
	await undoneElsewhere("a", TURN);
	assert.equal(paneUndo(LIB).disabled, true, "the popped-out pane went on offering to undo a file the card had already undone");
	assert.equal(paneUndo(APP).disabled, false);
});

test("undos of another conversation or another turn leave this one alone", async () => {
	view = await screen(h(TurnDeliveryCard, { timestamp: TURN }));
	await settle();
	undoable = { [APP]: false, [LIB]: false };
	await undoneElsewhere("b", TURN);
	await undoneElsewhere("a", TURN + 1);
	assert.ok(offersUndo());
});

test("a read that went out before an undo does not paint over it", async () => {
	held = [];
	view = await screen(h(TurnDeliveryCard, { timestamp: TURN }));
	await settle();
	// The read is out with every file undoable; an undo lands before it answers.
	undoable = { [APP]: false, [LIB]: true };
	await undoneElsewhere("a", TURN);
	const out = held;
	held = null;
	for (const release of out) release();
	await settle();
	assert.ok(document.querySelector("[data-turn-delivery]"), "the card shows the turn");
	assert.ok(!offersUndo(), "the read that predates the undo had the last word");
});
