/**
 * 设置 → 关于里「版本」下面那一行。
 *
 * 值得钉的是第三种情况：连不上 GitHub 时，检查把正在跑的版本当成最新的返回，和「检查成功、已是
 * 最新」长得一模一样。按 `available ? … : 已是最新` 写，没网的人就被告知自己用的是最新版。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act, createElement as h } from "react";
import { DEFAULT_SETTINGS } from "@plume/core";

import { AboutSettings } from "../../src/features/settings/AboutSettings.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { translate } from "../../src/i18n/translate.ts";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

const info = (checked: boolean) => ({ current: "0.3.2", latest: "0.3.2", available: false, checked, notes: "", url: "", publishedAt: null, asset: null });

Object.defineProperty(window, "plume", {
	configurable: true,
	value: {
		platform: "darwin",
		settings: { get: async () => DEFAULT_SETTINGS },
		updates: { check: () => new Promise(() => {}), state: async () => ({ at: "idle" }), onProgress: () => () => {} },
	},
});
useApp.setState({ settings: DEFAULT_SETTINGS, saveSettings: async () => {} } as never);

// 关于页挂上就起一个从不停的检查定时器（见 `features/update/store.ts` 的 `start`），收尾时作废。
after(() => (window as unknown as { happyDOM: { abort(): Promise<void> } }).happyDOM.abort());

const preview = (next: Record<string, unknown>) =>
	act(async () => (window as unknown as { __plumeUpdatePreview: (next: Record<string, unknown>) => void }).__plumeUpdatePreview(next));

test("没能检查时不说已是最新，检查过了才说", async () => {
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(AboutSettings) }));
	try {
		assert.ok(view.text().includes(translate("update.reading")), "回答到之前说在读，不编一个版本");

		await preview({ info: info(false) });
		assert.ok(view.text().includes(translate("about.offline")), view.text());
		assert.ok(!view.text().includes(translate("about.latest")), "离线时说成了已是最新");

		await preview({ info: info(true) });
		assert.ok(view.text().includes(translate("about.latest")), view.text());
	} finally {
		await view.unmount();
	}
});
