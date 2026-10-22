/**
 * 点开左下角的更新点，就重新问一次最新版本。
 *
 * 从前点开只是把窗口启动时（或 6 小时前）那次检查的结果拿出来：发布了新版本之后弹窗还是上一个版本，
 * 点下载下的也是上一个版本。离线时那次重新检查会失败，失败不能把已知的新版本冲掉——点和挂在点里
 * 的弹窗会在刚点开的瞬间一起消失。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { DEFAULT_SETTINGS } from "@plume/core";

import { UpdateBadge } from "../../src/features/update/index.ts";
import { mount } from "../helpers/mount.ts";

const info = (latest: string, checked = true) => ({
	current: "0.9.0",
	latest: checked ? latest : "0.9.0",
	available: checked,
	checked,
	notes: "",
	url: "https://example.invalid",
	publishedAt: null,
	asset: null,
	checksums: null,
});

let answer = info("0.9.1");
const calls: Array<boolean | undefined> = [];
Object.defineProperty(window, "plume", {
	configurable: true,
	value: {
		settings: { get: async () => DEFAULT_SETTINGS },
		updates: {
			check: async (force?: boolean) => {
				calls.push(force);
				return answer;
			},
			state: async () => ({ at: "idle" }),
			onProgress: () => () => {},
		},
	},
});

const settle = () => act(async () => {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
});

test("点开时强制重新检查，弹窗换成刚发布的版本", async () => {
	// store 一启动就排上 6 小时的后台检查，不清掉的话测试进程永远不退出。
	const timers: number[] = [];
	const original = window.setInterval;
	window.setInterval = ((handler: TimerHandler, ms?: number) => {
		const id = original(handler, ms);
		timers.push(id);
		return id;
	}) as typeof window.setInterval;
	const view = await mount(h(UpdateBadge));
	try {
		await settle();
		const dot = view.find<HTMLButtonElement>("button.ly-update-dot");
		assert.match(dot.getAttribute("aria-label") ?? "", /0\.9\.1/);

		answer = info("0.9.2");
		calls.length = 0;
		await act(async () => dot.click());
		await settle();

		assert.deepEqual(calls, [true], "点开那一下应当是一次 force 检查");
		assert.match(view.find("button.ly-update-dot").getAttribute("aria-label") ?? "", /0\.9\.2/);
		assert.ok(document.querySelector("[data-ly-update-dialog]"), "弹窗应当开着");

		// 离线：重新检查失败，已知的新版本留着，弹窗不被卸载。
		answer = info("", false);
		await act(async () => view.find<HTMLButtonElement>("button.ly-update-dot").click());
		await settle();
		assert.match(view.find("button.ly-update-dot").getAttribute("aria-label") ?? "", /0\.9\.2/);
		assert.ok(document.querySelector("[data-ly-update-dialog]"), "离线时弹窗不应消失");
	} finally {
		await view.unmount();
		window.setInterval = original;
		for (const id of timers) window.clearInterval(id);
	}
});
