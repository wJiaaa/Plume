/**
 * 呼吸点、扫光按拍走——见 `ui/motion/ticked.ts`。
 *
 * 测试用的 DOM 不跑 CSS 动画，这里给元素塞几个假的：只看 hook 对它们做了什么。钉住三件事：点名的
 * 被暂停、之后每拍往前拨（窗口没焦点时停住）；没点名的（悬停时的滚动）一下都不碰；不再按拍走时交还给浏览器接着播。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useRef } from "react";
import { useTickedAnimations } from "../../src/ui/motion/ticked.ts";
import { mount } from "../helpers/mount.ts";

class FakeAnimation {
	playState = "running";
	currentTime: number;
	readonly animationName: string;
	constructor(name: string, at: number) {
		this.animationName = name;
		this.currentTime = at;
	}
	pause() {
		this.playState = "paused";
	}
	play() {
		this.playState = "running";
	}
}

const NAMES = new Set(["ly-breathe-hue"]);
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

function Host({ active, animations }: { active: boolean; animations: FakeAnimation[] }) {
	const box = useRef<HTMLSpanElement>(null);
	useTickedAnimations(box, NAMES, active);
	return h("span", {
		ref: (element: HTMLSpanElement | null) => {
			box.current = element;
			if (element) Object.assign(element, { getAnimations: () => animations });
		},
	});
}

test("点名的动画暂停后按拍往前走，没点名的不碰，停下时交还给浏览器", async () => {
	const breathe = new FakeAnimation("ly-breathe-hue", 500);
	const hover = new FakeAnimation("ly-scroll", 0);
	const animations = [breathe, hover];
	const view = await mount(h(Host, { active: true, animations }));
	try {
		await wait(80);
		assert.equal(breathe.playState, "paused", "点名的那个交给拍子推");
		const first = breathe.currentTime;
		await wait(200);
		assert.ok(breathe.currentTime > first && breathe.currentTime >= 500, `拍子在往前拨：${first} → ${breathe.currentTime}`);
		assert.equal(hover.playState, "running", "悬停滚动不在名单里，照常逐帧");
		assert.equal(hover.currentTime, 0);

		await view.rerender(h(Host, { active: false, animations }));
		assert.equal(breathe.playState, "running", "不再按拍走时交还给浏览器，不留一个停住的动画");
	} finally {
		await view.unmount();
	}
});

test("窗口没焦点时停在原处，回到窗口从停下的地方接着走", async () => {
	const breathe = new FakeAnimation("ly-breathe-hue", 0);
	const view = await mount(h(Host, { active: true, animations: [breathe] }));
	try {
		await wait(80);
		window.dispatchEvent(new Event("blur"));
		await wait(150);
		const frozen = breathe.currentTime;
		await wait(300);
		assert.equal(breathe.currentTime, frozen, "没人看着的时候不拨");
		window.dispatchEvent(new Event("focus"));
		await wait(150);
		assert.ok(breathe.currentTime > frozen, "回来接着走");
		assert.ok(breathe.currentTime - frozen < 300, `不把失焦那段补回来：跳了 ${breathe.currentTime - frozen}ms`);
	} finally {
		window.dispatchEvent(new Event("focus"));
		await view.unmount();
	}
});
