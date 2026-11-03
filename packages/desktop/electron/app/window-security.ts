/**
 * Attaching the security rules to Electron.
 *
 * The rules themselves are in `security-policy.ts`, which imports nothing from Electron — see the
 * note there for why they are apart. This file is the wiring: which event, on which object, at which moment.
 *
 * All four are from Electron's own security checklist. None is clever; the reason to gather them is
 * that each is invisible until it is missing, and three of them were.
 */

import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { session, shell, type WebContents, type WebPreferences } from "electron";
import type { OpenPathOutcome } from "@plume/contract";

import { isRemoteOrDevicePath } from "../../shared/remote-path.ts";
import { harden, isOpenable, isOurPage, isPermissionGranted, isWebviewSourceAllowed, opensAsProgram } from "./security-policy.ts";

/** The dev server's origin, or undefined in a packaged build. */
const devServer = () => process.env.ELECTRON_RENDERER_URL;

/**
 * The bundled renderer every window with the preload loads, and the only `file:` page they may show.
 *
 * One path for the loaders and the navigation check, so the two cannot drift apart. The main
 * process is one bundle (`out/main/index.js`), which is why `import.meta.dirname` is the same here as
 * in `window.ts`.
 */
export const rendererEntry = (): string => join(import.meta.dirname, "../renderer/index.html");
const entryUrl = () => pathToFileURL(rendererEntry()).href;

/** Hand a URL to the user's browser, or refuse it. Returns whether it was opened. */
export function openExternalSafely(raw: string): boolean {
	if (!isOpenable(raw)) return false;
	void shell.openExternal(new URL(raw).href);
	return true;
}

/**
 * Open a file with its default application — unless that would run it, in which case show it.
 *
 * A share is never opened either: running something off `\\host\share` is running a stranger's
 * program, and whether a remote file is a program is not something to stat over the network to find
 * out. The outcome goes back so the window can say why a click showed a folder instead.
 */
export async function openPathSafely(path: string): Promise<OpenPathOutcome> {
	if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return "failed";
	if (isRemoteOrDevicePath(path)) {
		shell.showItemInFolder(path);
		return "revealed";
	}
	// Both names are judged: LaunchServices follows a symlink, so `notes.txt` → `/bin/sh` runs a shell.
	const real = await realpath(path).catch(() => path);
	const info = await stat(real).catch(() => null);
	const facts = { isDirectory: info?.isDirectory() ?? false, executable: ((info?.mode ?? 0) & 0o111) !== 0 };
	if (opensAsProgram(path, facts, process.platform) || opensAsProgram(real, facts, process.platform)) {
		shell.showItemInFolder(path);
		return "revealed";
	}
	return (await shell.openPath(path)) === "" ? "opened" : "failed";
}

/** Keep `contents` on our own page; send everything else to the browser. Every window with the preload needs it. */
export function guardNavigation(contents: WebContents): void {
	contents.on("will-navigate", (event, url) => {
		if (isOurPage(url, devServer(), entryUrl())) return;
		event.preventDefault();
		openExternalSafely(url);
	});

	/*
	 * Redirects are refused rather than sent to the browser.
	 *
	 * A redirect is not something the user asked for, so opening a window for it would be a
	 * navigation nobody initiated — and a chain ending somewhere hostile is exactly how an
	 * ordinary-looking link becomes a problem.
	 */
	contents.on("will-redirect", (event, url) => {
		if (!isOurPage(url, devServer(), entryUrl())) event.preventDefault();
	});

	// Links asking for a new window open in the user's browser; no page may open a window of its own.
	contents.setWindowOpenHandler(({ url }) => {
		openExternalSafely(url);
		return { action: "deny" };
	});
}

/**
 * Constrain every `<webview>` this page attaches.
 *
 * `will-attach-webview` fires on the embedder, so a tag written into the page by injected markup
 * cannot quietly ask for node integration or a preload — those are taken away here regardless of
 * what the tag said.
 */
export function guardWebviews(contents: WebContents): void {
	contents.on("will-attach-webview", (event, preferences: WebPreferences, params) => {
		harden(preferences);
		if (!isWebviewSourceAllowed(String((params as { src?: string }).src ?? ""))) event.preventDefault();
	});
}

/** Answer permission requests for the default session and any extra partitions. */
export function installPermissionHandlers(partitions: string[]): void {
	const sessions = [session.defaultSession, ...partitions.map((name) => session.fromPartition(name))];

	for (const ses of sessions) {
		ses.setPermissionRequestHandler((contents, permission, callback) => {
			callback(isPermissionGranted(contents?.getURL() ?? "", permission, devServer(), entryUrl()));
		});
		/*
		 * The synchronous half.
		 *
		 * Some capabilities are checked rather than requested — a page asking whether it *could*
		 * have the microphone. Leaving this unset means the answer is yes for things the handler
		 * above would refuse, which is a confusing pair of answers to give.
		 */
		ses.setPermissionCheckHandler((contents, permission) =>
			isPermissionGranted(contents?.getURL() ?? "", permission, devServer(), entryUrl()),
		);
	}
}
