/**
 * What a window may open, go to, host and be granted — as decisions, not as wiring.
 *
 * A renderer with a preload is the most privileged surface this application has: `window.plume`
 * reaches the filesystem, the shell and the model keys. These rules exist so that surface only ever
 * hosts our own page, and so the pages we *do* host cannot ask for more than they need.
 *
 * Kept apart from `window-security.ts`, which attaches them to Electron, because what is worth
 * arguing with is the rule, and a rule that imports `electron` cannot be argued with outside
 * Electron. It matters more than usual here — every one of these functions exists to *refuse* something, and a
 * refusal that quietly stopped working looks exactly like one that was never reached.
 */

import { posix, win32 } from "node:path";

/**
 * Schemes we will hand to the operating system.
 *
 * `file:` is the one that matters. `shell.openExternal("file:///…")` opens that path with whatever
 * the OS associates with it — so a link in a model's answer becomes arbitrary local execution.
 */
const OPENABLE = new Set(["http:", "https:", "mailto:"]);

/** Whether this URL may be handed to the user's browser or mail client. */
export function isOpenable(raw: string): boolean {
	try {
		return OPENABLE.has(new URL(raw).protocol);
	} catch {
		return false;
	}
}

/**
 * Extensions the operating system runs, installs or follows rather than displays.
 *
 * `shell.openPath` is "double-click this", and a reply's file link reaches it. For a document that
 * opens a viewer; for any of these it runs something — a `.command` in Terminal, a `.js` under
 * Windows Script Host, a `.lnk` to wherever it points. Those are shown in their folder instead,
 * where running one is a decision the user makes with the file in front of them.
 *
 * Per platform, because the same name means different things: `.js` is a script on Windows and a
 * text file on macOS. Shell and Python scripts are on every list — Git Bash and the Python launcher
 * associate them on Windows, Terminal and Python Launcher on macOS.
 */
const RUNS_EVERYWHERE = new Set(["sh", "bash", "zsh", "csh", "tcsh", "ksh", "fish", "command", "py", "pyw", "pyz", "jar", "jnlp"]);
const RUNS_ON: Record<string, ReadonlySet<string>> = {
	win32: new Set([
		"exe", "com", "scr", "pif", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ws", "wsc", "hta",
		"msc", "msi", "msp", "mst", "msix", "msixbundle", "appx", "appxbundle", "appinstaller", "application", "appref-ms",
		"lnk", "url", "cpl", "reg", "inf", "scf", "sct", "chm", "gadget", "diagcab", "xbap", "xll", "pl",
		"settingcontent-ms", "library-ms", "search-ms", "searchconnector-ms",
	]),
	darwin: new Set([
		"app", "tool", "scpt", "scptd", "applescript", "workflow", "action", "pkg", "mpkg", "terminal",
		"fileloc", "inetloc", "webloc", "prefpane", "saver", "qlgenerator", "osax", "mobileconfig", "definition",
	]),
	linux: new Set(["desktop", "appimage", "run"]),
};

/** What `opensAsProgram` needs to know about the thing on disk; the name says the rest. */
export interface PathFacts {
	isDirectory: boolean;
	/** Any execute bit set. Meaningless on Windows, where the extension is what decides. */
	executable: boolean;
}

/**
 * Whether handing `path` to the system opener would run something rather than show it.
 *
 * Decided here and not in the renderer, which is the side that may be carrying an injected link.
 * Beyond the extension lists:
 * - Windows forgives a trailing dot or space (`a.exe.` runs `a.exe`) and reads `name:stream` as an
 *   alternate data stream, so both are stripped or refused before the extension is read.
 * - A directory runs only if it is a bundle (`Foo.app`); any other folder opens in the file manager.
 * - On macOS and Linux an executable file *without* an extension is a program — Finder opens it in
 *   Terminal and runs it. With an extension, the extension's application wins.
 */
export function opensAsProgram(path: string, facts: PathFacts, platform: string): boolean {
	const windows = platform === "win32";
	let name = (windows ? win32 : posix).basename(path);
	if (windows) {
		name = name.replace(/[. ]+$/, "");
		if (name.includes(":")) return true;
	}
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (!ext) return !windows && !facts.isDirectory && facts.executable;
	if (facts.isDirectory) return platform === "darwin" && RUNS_ON.darwin.has(ext);
	return RUNS_EVERYWHERE.has(ext) || (RUNS_ON[platform]?.has(ext) ?? false);
}

/**
 * Whether a URL is the page our windows are built from.
 *
 * In development the renderer comes from Vite over http; packaged, it is one `index.html` inside the
 * bundle — `entry`, the file URL `loadFile` was given. Anything else — a clicked link, a redirect, a
 * `location.href` written by injected script — is somewhere else.
 *
 * Without this rule one successful injection is enough: `location.href = "https://…"` loads a
 * remote page *into the window that holds the preload*, and that page then owns `window.plume`.
 *
 * It used to be any URL starting with `file://`, `ly-media://` or `ly-preview://`, and each of the
 * three was a way in. `file://attacker.example/share/evil.html` is a `file:` URL that Windows fetches
 * over SMB; a `ly-preview://` page is one the model wrote; a `ly-media://` one is any file in a
 * project. None of the three is ever a top-level page in a window with the preload — previews are
 * shown in a `<webview>`, which has no preload and asks for permissions as a guest, and media only
 * ever as subresources — so the only file that counts now is the entry itself: no host, same path.
 *
 * The dev server is compared as an origin rather than as a prefix. `startsWith` would accept
 * `http://localhost:51730` for a server on `:5173`, and — worse — a hostile page can put the whole
 * thing in its own name: `https://localhost:5173.evil.com`.
 */
export function isOurPage(url: string, devServer?: string, entry?: string): boolean {
	if (!url) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (devServer) {
		try {
			return parsed.origin === new URL(devServer).origin;
		} catch {
			return false;
		}
	}
	return entry ? isEntryFile(parsed, entry) : false;
}

/** Same file as `entry`: `file:`, no host, same path — the hash and query are the page's own routing. */
function isEntryFile(url: URL, entry: string): boolean {
	try {
		const ours = new URL(entry);
		if (url.protocol !== "file:" || ours.protocol !== "file:" || url.host !== "" || ours.host !== "") return false;
		const asked = decodeURIComponent(url.pathname);
		const expected = decodeURIComponent(ours.pathname);
		// A Windows drive path is compared without case, as Windows does — and Chromium may report the drive letter in either case.
		return /^\/[a-zA-Z]:\//.test(expected) ? asked.toLowerCase() === expected.toLowerCase() : asked === expected;
	} catch {
		return false;
	}
}

/**
 * What a `<webview>` may load.
 *
 * http(s) is the browser panel's whole point. `about:blank` is its empty state, `ly-preview:` is
 * how a generated page is shown. `file:` is deliberately absent: a guest that can read `file:///`
 * can read the disk through a page we did not write.
 */
export function isWebviewSourceAllowed(src: string): boolean {
	return /^(https?:\/\/|about:blank$|ly-preview:\/\/)/.test(src ?? "");
}

/**
 * Capabilities a page may ask the operating system for.
 *
 * Electron grants whatever is requested unless told otherwise — wrong for an application that hosts
 * other people's pages in a panel, where a site can simply ask for the camera and have it.
 *
 * Our own renderer needs almost nothing: everything it does with the machine goes through IPC,
 * where it can be reasoned about. Guests get only `GUEST_GRANTED`.
 *
 * `local-fonts` lets the code font menu list installed faces. Refused, `queryLocalFonts` does not
 * fail — it returns an empty list, and the menu silently shrinks to its presets.
 */
const GRANTED = new Set(["clipboard-sanitized-write", "fullscreen", "local-fonts"]);
/**
 * 网页也给的两项：都不碰机器上的东西，Chrome 也不问就给，而且都要人刚在页面里点过才能用。
 * 拒掉的代价是网页里的视频全屏不了、站点的「复制」按钮静默失灵。摄像头、定位这类照旧一项不给。
 */
const GUEST_GRANTED = new Set(["clipboard-sanitized-write", "fullscreen"]);

export function isPermissionGranted(url: string, permission: string, devServer?: string, entry?: string): boolean {
	if (!url) return false;
	return isOurPage(url, devServer, entry) ? GRANTED.has(permission) : GUEST_GRANTED.has(permission);
}

/** The preferences a guest gets, whatever its tag asked for. */
export interface GuestPreferences {
	preload?: string;
	nodeIntegration?: boolean;
	contextIsolation?: boolean;
	sandbox?: boolean;
}

/**
 * Take the keys away from the guest.
 *
 * Mutates rather than returns, because that is the shape Electron's event gives us: the object
 * handed to `will-attach-webview` *is* the one the guest is created with.
 */
export function harden(preferences: GuestPreferences): void {
	// Nothing in a guest page needs our preload, and handing it over would hand over `window.plume`.
	delete preferences.preload;
	preferences.nodeIntegration = false;
	preferences.contextIsolation = true;
	preferences.sandbox = true;
}
