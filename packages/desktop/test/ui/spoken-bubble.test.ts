/**
 * 子智能体面板里人发出的图：大图过 IPC 前停放成了文件，`data` 是空的，要从 `media` 取。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { UserMessage } from "@plume/core";
import { SpokenBubble } from "../../src/features/conversation/SpokenBubble.tsx";
import { mount } from "../helpers/mount.ts";

test("停放过的大图画成 ly-media 缩略图，不是一张空的 data: 地址", async () => {
	const message: UserMessage = { role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "", media: "abc.png" }] };
	const view = await mount(h(SpokenBubble, { message }));
	try {
		assert.equal(view.find<HTMLImageElement>("img").getAttribute("src"), "ly-media://m/abc.png?thumb=128");
	} finally {
		await view.unmount();
	}
});
