/**
 * What the window will and will not open, navigate to, or grant.
 *
 * The interesting assertions are the refusals, and each one names a way a privileged renderer stops
 * being ours: a `file:` URL handed to the OS opener runs whatever that path is associated with; a
 * navigation away from our own page loads a stranger into the window holding the preload; a
 * `<webview>` that keeps the preload hands `window.plume` to a site.
 *
 * Only the pure half is tested here — `window-security.ts` keeps its decisions as functions over
 * strings precisely so this file needs no Electron. Whether the listeners are actually attached is
 * a question for e2e, and a different kind of mistake.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	harden,
	isOpenable,
	isOurPage,
	isPermissionGranted,
	isWebviewSourceAllowed,
	opensAsProgram,
} from "../electron/app/security-policy.ts";

const ENTRY = "file:///Applications/Plume.app/Contents/Resources/app.asar/out/renderer/index.html";

test("外链：放行 http、https、mailto", () => {
	for (const url of ["https://example.com/x", "http://192.168.1.9:8080", "mailto:a@b.c", "HTTPS://EXAMPLE.COM"]) {
		assert.equal(isOpenable(url), true, `${url} 应该放行`);
	}
});

test("外链：拒绝一切能变成本地执行的东西", () => {
	const refused = [
		// 交给系统打开一个本地路径，等于让链接决定运行什么。这是这条规则存在的理由。
		"file:///etc/passwd",
		"file:///Applications/Calculator.app",
		"javascript:alert(1)",
		"data:text/html,<script>1</script>",
		// 我们自己的内部协议也不该交给系统去打开。
		"ly-media://f/x",
		"ly-preview://s/p",
		// 别的应用的深链，等于把「打开什么」的决定权交给了链接的作者。
		"vscode://file/etc/passwd",
		"不是一个 URL",
		"",
		"//example.com",
	];
	for (const url of refused) {
		assert.equal(isOpenable(url), false, `${url} 应该被拒`);
	}
});

test("导航：自己的页面与开发服务器算自己人", () => {
	assert.equal(isOurPage(ENTRY, undefined, ENTRY), true);
	// 路由在 hash 里，同一份文件换个 hash 还是它。
	assert.equal(isOurPage(`${ENTRY}#/screenshot-overlay`, undefined, ENTRY), true);
	assert.equal(isOurPage("http://localhost:5173/index.html", "http://localhost:5173"), true);
});

test("导航：Windows 上盘符大小写、转义写法不同，仍是同一份入口", () => {
	const entry = "file:///C:/Program%20Files/Plume/resources/app.asar/out/renderer/index.html";
	assert.equal(isOurPage("file:///c:/Program Files/Plume/resources/app.asar/out/renderer/index.html", undefined, entry), true);
	assert.equal(isOurPage("file:///D:/Program%20Files/Plume/resources/app.asar/out/renderer/index.html", undefined, entry), false);
});

test("导航：其余一律不是", () => {
	for (const url of [
		"https://example.com",
		"http://localhost:5173/index.html", // 没有开发服务器时，它也只是一个外部地址
		"about:blank",
		"data:text/html,x",
		"",
		// 带主机的 file: 在 Windows 上就是去连那台机器的 SMB 共享，页面是别人的。
		"file://attacker.example/share/evil.html",
		// 同一台机器上的别的文件：下载目录里的一份 html 也能拿到 window.plume。
		"file:///Users/me/Downloads/evil.html",
		"file:///Applications/Plume.app/Contents/Resources/app.asar/out/renderer/other.html",
		// 生成页是模型写的，媒体是项目里的任意文件；两者都不该成为带 preload 的窗口的顶层页面。
		"ly-preview://s/p/index.html",
		"ly-media://f/x",
	]) {
		assert.equal(isOurPage(url, undefined, ENTRY), false, `${url} 不该被当成我们的页面`);
	}
	// 不知道入口是哪份文件，就没有哪个 file: 算数。
	assert.equal(isOurPage(ENTRY), false);
});

test("导航：开发模式下只认开发服务器，打包入口的 file: 不再算", () => {
	assert.equal(isOurPage(ENTRY, "http://localhost:5173", ENTRY), false);
});

test("导航：开发服务器按 origin 比对，不是按前缀", () => {
	const dev = "http://localhost:5173";

	// 这三条是 `startsWith` 会放过而 origin 比对不会的。第二条最要命：
	// 一个敌意站点只要把开发服务器地址放进自己的域名里，前缀就匹配上了。
	assert.equal(isOurPage("http://localhost:51730/x", dev), false, "另一个端口不是同一个源");
	assert.equal(isOurPage("https://localhost:5173.evil.com", dev), false, "域名里带着它不算");
	assert.equal(isOurPage("https://localhost:5173", dev), false, "协议不同就不是同一个源");

	// 同源的各种写法都要认得。
	assert.equal(isOurPage("http://localhost:5173", dev), true);
	assert.equal(isOurPage("http://localhost:5173/index.html?x=1#y", dev), true);
});

test("webview：只允许 http(s)、about:blank 与预览协议", () => {
	for (const src of ["https://example.com", "http://localhost:3000", "about:blank", "ly-preview://s/p/i.html"]) {
		assert.equal(isWebviewSourceAllowed(src), true, `${src} 应该允许`);
	}
	for (const src of ["file:///etc/passwd", "ly-media://f/x", "data:text/html,x", "", "javascript:1", "about:config"]) {
		assert.equal(isWebviewSourceAllowed(src), false, `${src} 应该被拒`);
	}
});

test("webview：无论标签怎么写，客人都拿不到主人的钥匙", () => {
	const asked = {
		preload: "/path/to/preload.js",
		nodeIntegration: true,
		contextIsolation: false,
		sandbox: false,
		webSecurity: false,
	};
	harden(asked);

	assert.equal(asked.preload, undefined, "preload 必须被剥掉——它就是 window.plume");
	assert.equal(asked.nodeIntegration, false);
	assert.equal(asked.contextIsolation, true);
	assert.equal(asked.sandbox, true);
});

test("权限：自己的页面只拿到三项", () => {
	const ours = ENTRY;
	assert.equal(isPermissionGranted(ours, "fullscreen", undefined, ENTRY), true);
	assert.equal(isPermissionGranted(ours, "clipboard-sanitized-write", undefined, ENTRY), true);
	assert.equal(isPermissionGranted(ours, "local-fonts", undefined, ENTRY), true);

	// 自己的页面也不需要这些：要用摄像头会走 IPC，而不是问浏览器要。
	for (const permission of ["media", "geolocation", "notifications", "midi", "openExternal", "clipboard-read"]) {
		assert.equal(isPermissionGranted(ours, permission, undefined, ENTRY), false, `自己的页面也不该拿到 ${permission}`);
	}
	// 面板里的生成页按客人算：字体列表不给它。
	assert.equal(isPermissionGranted("ly-preview://s/p/index.html", "local-fonts", undefined, ENTRY), false);
	assert.equal(isPermissionGranted("ly-preview://s/p/index.html", "fullscreen", undefined, ENTRY), true);
});

test("权限：客人页面只有全屏和写剪贴板", () => {
	// 网页视频要能全屏、站点的「复制」按钮要能用；两项都不碰机器，Chrome 也不问就给。
	for (const permission of ["fullscreen", "clipboard-sanitized-write"]) {
		assert.equal(isPermissionGranted("https://example.com", permission), true, `客人应该拿到 ${permission}`);
	}
	for (const permission of ["local-fonts", "media", "notifications", "geolocation", "midi", "clipboard-read", "openExternal"]) {
		assert.equal(isPermissionGranted("https://example.com", permission), false, `客人不该拿到 ${permission}`);
	}
	for (const permission of ["fullscreen", "clipboard-sanitized-write", "media"]) {
		assert.equal(isPermissionGranted("", permission), false, "没有 URL 时一律拒绝");
	}
});

const FILE = { isDirectory: false, executable: false };

test("打开文件：会被运行的类型改为在文件夹中显示", () => {
	const cases: Array<[string, string]> = [
		["/Users/me/Downloads/run.command", "darwin"],
		["/Users/me/x.scpt", "darwin"],
		["/Users/me/x.fileloc", "darwin"],
		["/Users/me/install.sh", "darwin"],
		["/home/me/a.desktop", "linux"],
		["/home/me/a.AppImage", "linux"],
		["C:\\Users\\me\\a.exe", "win32"],
		["C:\\Users\\me\\a.BAT", "win32"],
		["C:\\Users\\me\\a.cmd", "win32"],
		["C:\\Users\\me\\a.ps1", "win32"],
		["C:\\Users\\me\\a.lnk", "win32"],
		["C:\\Users\\me\\a.js", "win32"],
		["C:\\Users\\me\\a.py", "win32"],
		// Windows 吞掉结尾的点和空格，`a.exe.` 跑的就是 `a.exe`。
		["C:\\Users\\me\\a.exe.", "win32"],
		["C:\\Users\\me\\a.exe . ", "win32"],
		// 备用数据流。
		["C:\\Users\\me\\a.txt:evil.exe", "win32"],
	];
	for (const [path, platform] of cases) assert.equal(opensAsProgram(path, FILE, platform), true, `${platform} ${path}`);
});

test("打开文件：文档照常用默认应用打开", () => {
	const cases: Array<[string, string]> = [
		["/Users/me/report.pdf", "darwin"],
		["/Users/me/notes.md", "darwin"],
		// 在 macOS 上 .js 只是文本；在 Windows 上它归 Windows Script Host。
		["/Users/me/app.js", "darwin"],
		["/home/me/a.png", "linux"],
		["C:\\Users\\me\\report.docx", "win32"],
		["C:\\Users\\me\\notes.txt", "win32"],
		["C:\\Users\\me\\README", "win32"],
	];
	for (const [path, platform] of cases) assert.equal(opensAsProgram(path, FILE, platform), false, `${platform} ${path}`);
});

test("打开文件：目录只有 .app 这类包才算程序", () => {
	const dir = { isDirectory: true, executable: true };
	assert.equal(opensAsProgram("/Applications/Calculator.app", dir, "darwin"), true);
	assert.equal(opensAsProgram("/Users/me/x.prefPane", dir, "darwin"), true);
	assert.equal(opensAsProgram("/Users/me/project", dir, "darwin"), false);
	assert.equal(opensAsProgram("/Users/me/my.project", dir, "darwin"), false);
	assert.equal(opensAsProgram("C:\\Users\\me\\tools.exe", dir, "win32"), false);
});

test("打开文件：没有扩展名、带可执行位的文件在 macOS 与 Linux 上是程序", () => {
	const exec = { isDirectory: false, executable: true };
	assert.equal(opensAsProgram("/Users/me/bin/deploy", exec, "darwin"), true);
	assert.equal(opensAsProgram("/home/me/bin/deploy", exec, "linux"), true);
	assert.equal(opensAsProgram("/Users/me/bin/deploy", FILE, "darwin"), false);
	// 有扩展名时归扩展名的应用：带了 +x 的文档仍是文档。
	assert.equal(opensAsProgram("/Users/me/notes.txt", exec, "darwin"), false);
	// 点开头的是隐藏文件的名字，不是扩展名。
	assert.equal(opensAsProgram("/Users/me/.envrc", exec, "darwin"), true);
});
