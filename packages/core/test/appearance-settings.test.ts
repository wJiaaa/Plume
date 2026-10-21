/**
 * How an appearance file is read back: the defaults underneath, what the user chose on top.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_APPEARANCE, normalizeSettings } from "../src/config/settings.ts";

test("an explicit font size survives reload even when it matches an old default", () => {
	for (const uiFontSize of [11, 12, 13, 14, 15, 20]) {
		const stored = { appearance: { ...DEFAULT_APPEARANCE, uiFontSize } };
		assert.equal(normalizeSettings(stored).appearance.uiFontSize, uiFontSize);
	}
	assert.equal(normalizeSettings({}).appearance.uiFontSize, DEFAULT_APPEARANCE.uiFontSize);
});

test("没表过态的人跟着系统走，表过态的人不动", () => {
	/*
	 * 主进程一侧一直是这个行为——`electron/window.ts` 读不到设置时按 `nativeTheme.shouldUseDarkColors`
	 * 画启动屏。而默认值此前是 `dark`，于是系统是浅色的机器上，启动屏按系统画成浅色、渲染进程一加载
	 * 又被拽回深色，开机第一眼是一次闪烁。两边得说同一件事。
	 */
	assert.equal(DEFAULT_APPEARANCE.theme, "system", "没选过主题就跟着系统");

	// 而选过的人，选的还在——`normalizeSettings` 的合并方向是「默认在下、存的在上」。
	for (const chosen of ["light", "dark", "system"] as const) {
		assert.equal({ ...DEFAULT_APPEARANCE, theme: chosen }.theme, chosen);
	}
});

test("背景图开关：之前设过图的人读进来两处都开着，关过总开关的人两处都关着", () => {
	// 这两个字段是后加的，旧的设置文件里没有它们。
	const before = normalizeSettings({ appearance: { chatBackground: "chat-1.jpg" } }).appearance;
	assert.equal(before.chatBackground, "chat-1.jpg");
	assert.equal(before.chatBackgroundOnNewChat, true);
	assert.equal(before.chatBackgroundInChat, true);

	const legacyOff = normalizeSettings({ appearance: { chatBackground: "chat-1.jpg", chatBackgroundEnabled: false } as never }).appearance;
	assert.equal(legacyOff.chatBackgroundOnNewChat, false);
	assert.equal(legacyOff.chatBackgroundInChat, false);
	assert.equal(legacyOff.chatBackground, "chat-1.jpg", "关掉不丢图");
	assert.equal("chatBackgroundEnabled" in legacyOff, false, "旧的总开关不再带回内存");

	const split = normalizeSettings({ appearance: { chatBackground: "chat-1.jpg", chatBackgroundOnNewChat: true, chatBackgroundInChat: false } }).appearance;
	assert.equal(split.chatBackgroundOnNewChat, true);
	assert.equal(split.chatBackgroundInChat, false);
});
