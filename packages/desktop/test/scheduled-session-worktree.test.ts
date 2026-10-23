/**
 * 定时任务开的会话，和输入框开的走同一条路：先落盘，再按落盘的样子起来。
 *
 * 从前它另写了一遍：工作树用一个随机 id 命名，建不成就悄悄回到项目里跑、什么也不记，meta 自己拼一份，
 * 也不接共享的 MCP 池。现在照常记下工作树（连同它的根目录）；建不成时原因记在会话上。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DEFAULT_SETTINGS, SessionStore, type Settings } from "@plume/core";
import { canonicalPath } from "../electron/path-key.ts";

const exec = promisify(execFile);

// Electron is not there under node; every name it exports is a no-op that answers anything.
const electronUrl = `data:text/javascript,${encodeURIComponent(`
const any = new Proxy(function () {}, { get: (_, key) => (key === "then" ? undefined : any), apply: () => any, construct: () => any });
export const app = any, BrowserWindow = any, clipboard = any, contextBridge = any, desktopCapturer = any, dialog = any,
	globalShortcut = any, ipcMain = any, ipcRenderer = any, Menu = any, nativeImage = any, nativeTheme = any, net = any,
	Notification = any, powerSaveBlocker = any, protocol = any, screen = any, session = any, shell = any,
	systemPreferences = any, Tray = any, webContents = any, webUtils = any;
export default any;
`)}`;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron") return { url: electronUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const hub = await import("../electron/session/session-hub.ts");
hooks.deregister();

const home = await mkdtemp(join(tmpdir(), "plume-scheduled-"));
process.env.PLUME_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));

const repo = join(home, "repo");
await mkdir(repo, { recursive: true });
await exec("git", ["init", "--initial-branch=main", repo]);
await exec("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "init"]);

const store = new SessionStore(join(home, "sessions"));
let settings: Settings = { ...DEFAULT_SETTINGS, worktrees: { autoCreateOnNewSession: true, rootDir: join(home, "trees") } };
hub.configureHub({ store: () => store, settings: () => settings, window: () => null });

test("设置要工作树：定时任务的会话在自己的工作树里跑，meta 记下项目、分支和根目录", async () => {
	const session = await hub.getOrCreateSession(repo, "", "project-1");
	const meta = (await store.get(session.meta.id))!;
	assert.equal(meta.project, "project-1");
	assert.equal(meta.workspaceSetup, undefined, "the marker is done with");
	assert.equal(meta.worktree?.project, repo);
	assert.equal(meta.worktree?.branch, `plume/session-${meta.id.slice(0, 8)}`, "named for the conversation, not a throwaway id");
	assert.equal(meta.worktree?.root, meta.cwd);
	assert.ok(canonicalPath(meta.cwd).startsWith(canonicalPath(join(home, "trees"))), meta.cwd);
	assert.equal(session.cwd, meta.cwd);
	await hub.disposeSession(session.meta.id, "other");
});

test("建不成工作树：照样起来，在项目里跑，原因记在会话上", async () => {
	const plain = join(home, "plain");
	await mkdir(plain, { recursive: true });
	const session = await hub.getOrCreateSession(plain, "", undefined);
	const meta = (await store.get(session.meta.id))!;
	assert.equal(meta.cwd, plain);
	assert.equal(meta.worktree, undefined);
	assert.ok(meta.worktreeError, "the reason is kept, not swallowed");
	await hub.disposeSession(session.meta.id, "other");
});

test("设置不要工作树：就在项目里跑", async () => {
	settings = { ...DEFAULT_SETTINGS };
	const session = await hub.getOrCreateSession(repo, "", undefined);
	const meta = (await store.get(session.meta.id))!;
	assert.equal(meta.cwd, repo);
	assert.equal(meta.worktree, undefined);
	assert.equal(meta.worktreeError, undefined);
	await hub.disposeSession(session.meta.id, "other");
});
