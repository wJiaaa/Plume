/**
 * 会话窗背景图：选一张、读出来、删掉。
 *
 * 图复制进 `~/.plume/backgrounds/`，原图挪走、改名都不影响。只留一张：换图时旧的那张就删，
 * 否则每换一次就在用户目录里多躺几 MB 没人引用的东西。
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { plumeHome } from "@plume/core";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { nativeText } from "../i18n.ts";

const EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

/** 一整张图要读进渲染进程再解码，太大的照片在这里就拦下，而不是让窗口去吞它。 */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 只认自己写下的名字。`read` 收的是渲染进程给的字符串，不收路径——
 * 认不出来的一律当作没有，`../` 之类的东西走不到文件系统。
 */
const NAME = /^chat-\d+\.(?:png|jpe?g|gif|webp)$/;

const directory = () => join(plumeHome(), "backgrounds");

async function clear(dir: string, keep?: string): Promise<void> {
	const names = await readdir(dir).catch(() => [] as string[]);
	await Promise.all(names.filter((name) => NAME.test(name) && name !== keep).map((name) => rm(join(dir, name), { force: true })));
}

export function registerChatBackgroundIpc(): void {
	ipcMain.handle("chatBackground:pick", async (event) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		const options = {
			title: nativeText("dialog.chatBackground"),
			properties: ["openFile" as const],
			filters: [{ name: "Images", extensions: EXTENSIONS }],
		};
		const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		const source = result.filePaths[0];
		if (result.canceled || !source) return null;
		const info = await stat(source);
		if (!info.isFile()) return null;
		if (info.size > MAX_BYTES) return { error: "too-large" as const };
		const ext = extname(source).slice(1).toLowerCase();
		if (!EXTENSIONS.includes(ext)) return null;

		const dir = directory();
		await mkdir(dir, { recursive: true });
		const name = `chat-${Date.now()}.${ext}`;
		// 先复制到临时名再改名：选中的正是现在这张时，先删旧的就把源文件删没了。
		const temp = join(dir, `.${name}.part`);
		await copyFile(source, temp);
		await rename(temp, join(dir, name));
		await clear(dir, name);
		return { name };
	});

	ipcMain.handle("chatBackground:read", async (_event, name: string): Promise<Uint8Array | null> => {
		if (typeof name !== "string" || !NAME.test(name)) return null;
		return readFile(join(directory(), name)).catch(() => null);
	});

	ipcMain.handle("chatBackground:remove", async () => clear(directory()));
}
