import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { cleanupFixture } from "./fixture-cleanup.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { until } from "./drive.ts";

/*
 * 网页拿 302 去唤起桌面客户端（飞书授权页过期后就是这样）：内置浏览器照旧不跟过去，但从前标签停在一张
 * 白页上、地址栏不动、什么也不说。现在盖一层，说清楚它要去哪、并给出交给系统浏览器的那个网页地址。
 */
let app: RunningApp;
let server: Server;
let base = "";
const TARGET = "lark://applink.feishu.cn/client/op/open";

before(async () => {
	server = createServer((req, res) => {
		if (req.url === "/redirect") { res.writeHead(302, { location: TARGET }); res.end(); return; }
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		// 已经立着的页面自己用脚本去试唤起：不少站点一打开就这么干，这种不能盖住页面。
		if (req.url === "/try-app") { res.end(`<title>try</title><h1>PAGE STAYS</h1><script>setTimeout(() => { location.href = ${JSON.stringify(TARGET)}; }, 200)</script>`); return; }
		res.end("<title>ok</title><h1>OK</h1>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	base = `http://127.0.0.1:${address.port}`;
	app = await startApp({ port: 9633, seed: (home) => seedInteractions(home, address.port) });
});
after(async () => { await cleanupFixture(() => app?.stop(), () => closeListeningServer(server)); });

type Tab = { id: string; url: string; failure?: { kind: string; detail: string; url?: string } };
const state = () => app.evaluate<{ tabs: Tab[]; activeId: string }>("window.plume.browser.state()");
const open = (url: string) => app.evaluate(`window.plume.browser.command(${JSON.stringify({ type: "open", url, sessionId: null, newTab: true })}).then(() => true)`);

test("重定向到非网页地址时盖一层说明，而不是停在白页上", async () => {
	await open(`${base}/redirect`);
	await until(app, `document.querySelector('[data-browser-failure="blocked"]') !== null`);
	const { tabs, activeId } = await state();
	const tab = tabs.find((entry) => entry.id === activeId);
	assert.deepEqual(tab?.failure, { kind: "blocked", detail: TARGET, url: `${base}/redirect` });
	// 地址栏仍是点开的那个链接，遮罩上写着它要去的地址，并有一颗交给系统浏览器的按钮。
	assert.equal(tab?.url, `${base}/redirect`);
	const overlay = await app.evaluate<{ text: string; buttons: number }>(`(() => { const el = document.querySelector('[data-browser-failure="blocked"]'); return { text: el.innerText, buttons: el.querySelectorAll('button').length }; })()`);
	assert.match(overlay.text, /lark:\/\/applink\.feishu\.cn/);
	assert.equal(overlay.buttons, 1);
});

test("页面已经立着、自己试着唤起客户端时不盖住页面", async () => {
	await open(`${base}/try-app`);
	await until(app, `document.querySelector('webview[src$="/try-app"]') !== null`);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const { tabs, activeId } = await state();
	const tab = tabs.find((entry) => entry.id === activeId);
	assert.equal(tab?.failure, undefined);
	const text = await app.evaluate<string>(`document.querySelector('webview[src$="/try-app"]').executeJavaScript('document.body.innerText')`);
	assert.match(text, /PAGE STAYS/);
});
