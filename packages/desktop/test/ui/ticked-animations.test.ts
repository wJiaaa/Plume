/**
 * 呼吸点、扫光按拍走——见 `ui/motion/ticked.ts`。
 *
 * 测试用的 DOM 不跑 CSS 动画，这里给元素塞几个假的：只看 hook 对它们做了什么。钉住四件事：点名的
 * 被暂停、之后每拍往前拨（最小化时停住，失焦照走）；没点名的（悬停时的滚动）一下都不碰；不再按拍走时交还给浏览器接着播；
 * 几个元素同一拍里先读后写。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useRef } from "react";
import { useTickedAnimations } from "../../src/ui/motion/ticked.ts";
import { setWindowMinimized } from "../../src/ui/motion/ticker.ts";
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

test("窗口失焦照走，最小化时停在原处，还原后从停下的地方接着走", async () => {
	const breathe = new FakeAnimation("ly-breathe-hue", 0);
	const view = await mount(h(Host, { active: true, animations: [breathe] }));
	try {
		await wait(80);
		window.dispatchEvent(new Event("blur"));
		const blurred = breathe.currentTime;
		await wait(350);
		assert.ok(breathe.currentTime > blurred, "并排摆着的窗口人还看得见，失焦不停");
		setWindowMinimized(true);
		await wait(150);
		const frozen = breathe.currentTime;
		await wait(300);
		assert.equal(breathe.currentTime, frozen, "最小化了没人看着，不拨");
		setWindowMinimized(false);
		await wait(250);
		assert.ok(breathe.currentTime > frozen, "还原后接着走");
		assert.ok(breathe.currentTime - frozen < 300, `不把最小化那段补回来：跳了 ${breathe.currentTime - frozen}ms`);
	} finally {
		setWindowMinimized(false);
		window.dispatchEvent(new Event("focus"));
		await view.unmount();
	}
});

test("几个元素同一拍里先全部读完再一起写，不交错", async () => {
	const log: string[] = [];
	const a = new FakeAnimation("ly-breathe-hue", 0);
	const b = new FakeAnimation("ly-breathe-hue", 0);
	for (const [name, animation] of [["a", a], ["b", b]] as const) {
		let time = animation.currentTime;
		Object.defineProperty(animation, "currentTime", {
			get: () => time,
			set: (value: number) => {
				log.push(`write ${name}`);
				time = value;
			},
		});
	}
	function Reader({ name, animation }: { name: string; animation: FakeAnimation }) {
		const box = useRef<HTMLSpanElement>(null);
		useTickedAnimations(box, NAMES);
		return h("span", {
			ref: (element: HTMLSpanElement | null) => {
				box.current = element;
				if (element)
					Object.assign(element, {
						getAnimations: () => {
							log.push(`read ${name}`);
							return [animation];
						},
					});
			},
		});
	}
	const view = await mount(h("div", null, h(Reader, { name: "a", animation: a }), h(Reader, { name: "b", animation: b })));
	try {
		await wait(200);
		const writes = log.map((entry, at) => (entry.startsWith("write") ? at : -1)).filter((at) => at >= 0);
		assert.ok(writes.length >= 2, `拍子在拨：${log.join(", ")}`);
		const first = writes[0];
		// 第一次写所在的那一拍：前面紧挨着的两次读是这一拍的，后面紧跟的是两次写。
		assert.deepEqual(log.slice(first - 2, first + 2).map((entry) => entry.split(" ")[0]), ["read", "read", "write", "write"], log.join(", "));
	} finally {
		await view.unmount();
	}
});
