import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { Markdown } from "../../src/features/conversation/Markdown.tsx";
import { fire, mount } from "../helpers/mount.ts";

const QR = "/Users/me/.plume/workspaces/chats/2026-10-19/badaf2f3/feishu-auth-qr.png";

/** `files.read` answering with this `modifiedAt`, or refusing when it is null. */
async function withFiles<T>(modifiedAt: number | null, run: () => Promise<T>): Promise<T> {
	const previous = Object.getOwnPropertyDescriptor(window, "plume");
	const files = {
		read: async () => (modifiedAt === null ? null : { text: "", truncated: false, bytes: 10, binary: true, modifiedAt }),
		mediaUrl: (path: string, version?: number) => `ly-media://f/${encodeURIComponent(path)}${version === undefined ? "" : `?v=${version}`}`,
	};
	Object.defineProperty(window, "plume", { configurable: true, value: { files } });
	try {
		return await run();
	} finally {
		if (previous) Object.defineProperty(window, "plume", previous); else Reflect.deleteProperty(window, "plume");
	}
}

const reply = (text: string) => h(Markdown, { text, localImages: true });

test("a reply's picture at a local path is drawn, addressed by the file's version", async () => {
	await withFiles(1792379123795, async () => {
		const element = reply(`![飞书授权二维码](${QR})`);
		const view = await mount(element);
		try {
			await view.rerender(element);
			const img = view.find<HTMLImageElement>("img.ly-md-image");
			// 同一路径被覆盖后版本变了，地址跟着变，Chromium 不会再拿出旧图。
			assert.equal(img.getAttribute("src"), `ly-media://f/${encodeURIComponent(QR)}?v=1792379123795`);
			assert.equal(img.getAttribute("alt"), "飞书授权二维码");
		} finally {
			await view.unmount();
		}
	});
});

test("a reply's picture the window may not read stays a link", async () => {
	await withFiles(null, async () => {
		const element = reply(`![飞书授权二维码](${QR})`);
		const view = await mount(element);
		try {
			await view.rerender(element);
			assert.equal(view.host.querySelector("img"), null);
			assert.match(view.text(), /飞书授权二维码/);
		} finally {
			await view.unmount();
		}
	});
});

test("a reply's picture that fails to load falls back to its link", async () => {
	await withFiles(1, async () => {
		const element = reply(`![飞书授权二维码](${QR})`);
		const view = await mount(element);
		try {
			await view.rerender(element);
			await fire(view.find("img.ly-md-image"), new Event("error"));
			assert.equal(view.host.querySelector("img"), null);
			assert.match(view.text(), /飞书授权二维码/);
		} finally {
			await view.unmount();
		}
	});
});

test("without localImages a local path in text with no directory stays a link", async () => {
	await withFiles(1, async () => {
		const view = await mount(h(Markdown, { text: `![飞书授权二维码](${QR})` }));
		try {
			assert.equal(view.host.querySelector("img"), null);
		} finally {
			await view.unmount();
		}
	});
});

test("written while the reply streams: a placeholder from the first `![`, then the picture develops in its place", async () => {
	await withFiles(7, async () => {
		const head = "也可以使用下面的二维码：\n\n";
		const view = await mount(h(Markdown, { text: head, streaming: true, localImages: true }));
		// 字按上游最近的速度排进时间线、最多落后 700ms（stream-pace.ts），600ms 等不到地址写完。
		const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 1500)));
		try {
			await view.rerender(h(Markdown, { text: `${head}![飞书授权二维码](${QR.slice(0, 30)}`, streaming: true, localImages: true }));
			await settle();
			assert.equal(view.all(".ly-md-image-pending").length, 1, "地址还在写：先有一块占位");
			assert.equal(view.host.querySelector("img"), null);

			await view.rerender(h(Markdown, { text: `${head}![飞书授权二维码](${QR})`, streaming: true, localImages: true }));
			await settle();
			const img = view.find<HTMLImageElement>("img.ly-md-image");
			assert.ok(img.classList.contains("ly-md-image-waiting"), "加载完之前图不占地方");
			assert.equal(view.all(".ly-md-image-pending").length, 1, "占位还在，只有一块");

			await fire(img, new Event("load"));
			assert.equal(view.all(".ly-md-image-pending").length, 0, "图到了，占位让位");
			assert.ok(img.classList.contains("ly-image-reveal") && !img.classList.contains("ly-md-image-waiting"), "在原处显影");
		} finally {
			await view.unmount();
		}
	});
});

test("a finished transcript's picture is simply there: no placeholder, no reveal", async () => {
	await withFiles(7, async () => {
		const element = reply(`![飞书授权二维码](${QR})`);
		const view = await mount(element);
		try {
			await view.rerender(element);
			const img = view.find<HTMLImageElement>("img.ly-md-image");
			assert.equal(img.className, "ly-md-image ly-md-image-block", "没有占位也不显影；没加载完先当大图，独占一行");
			assert.equal(view.all(".ly-md-image-pending").length, 0);
		} finally {
			await view.unmount();
		}
	});
});

test("a reply's picture taller than two lines stands on its own line; an icon stays in the sentence", async () => {
	await withFiles(7, async () => {
		const element = reply(`扫一下 ![二维码](${QR}) 然后回复，正常时显示 ![图标](${QR.replace("qr", "icon")}) 这个图标。`);
		const view = await mount(element);
		try {
			await view.rerender(element);
			const [qr, icon] = view.all<HTMLImageElement>("img.ly-md-image");
			const load = async (img: HTMLImageElement, naturalHeight: number) => {
				Object.defineProperty(img, "naturalHeight", { configurable: true, value: naturalHeight });
				await fire(img, new Event("load"));
			};
			await load(qr, 256);
			await load(icon, 24);
			assert.ok(qr.classList.contains("ly-md-image-block"), "256px 的二维码独占一行");
			assert.ok(!icon.classList.contains("ly-md-image-block"), "24px 的图标留在字里");
		} finally {
			await view.unmount();
		}
	});
});

test("pictures in a file the pane opened keep their inline layout", async () => {
	await withFiles(7, async () => {
		const view = await mount(h(Markdown, { text: "![logo](assets/logo.png)", baseDir: "/project" }));
		try {
			assert.equal(view.find("img").className, "ly-md-image");
		} finally {
			await view.unmount();
		}
	});
});
