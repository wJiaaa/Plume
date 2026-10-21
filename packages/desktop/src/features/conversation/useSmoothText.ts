/**
 * 正在输出的回复，按 `Pace` 排的时间线逐帧切原文，而不是来多少画多少。节奏为什么这样排，见
 * `stream-pace.ts`。
 *
 * **放到哪画到哪。** 屏幕上只有已经放出来的字，版面和看得见的字是同一回事。也试过先把到了的字全排进
 * 版面、透明着等时刻淡入：跟随滚动能提前知道前沿在哪，代价是透明的字进了版面——滚动条能滚进一片
 * 空白、能选中看不见的字、每帧要量 DOM 找前沿、每一种块都得记得领一个时刻。那些不是实现的毛病，
 * 是方案带来的。版面台阶式地长这件事交给跟随滚动（`useFollowBottom`），那里有一段跑道接着。
 *
 * **写完不等于演完。** `live` 落下时，还没放出来的字照常放完，最后一个字淡完之后才交出
 * `active: false`，调用方这时才换回原文。短回复尤其要这样：一句话往往整句到达、紧接着就结束，
 * 从前在结束那一刻直接给全文、掐掉淡入，字是实着蹦出来的。
 *
 * **重挂之后接着演。** 一轮既没想也没调工具时，跑完那一刻它从「过程」退回一句回答（见 `turnBlocks`），
 * 换了父元素，整段重挂。新挂上的原文以正在演的那段为开头，就接过同一条时间线：已经放出来的照旧在，
 * 还没放的照旧等着，不会把剩下的一次画出来，也不从头重放。
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { FADE, holdsWord, Pace, wordCut } from "./stream-pace.ts";

/**
 * 挂上时就有这么多字以上，当作打开了一个写到一半的会话：直接画出来，不重放。再少的按刚到的放。
 * 转录里是不是「打开」由 `Arrival` 说了算，这条只管没有它的地方。
 */
const REPLAY = 2000;

/**
 * 这一页刚露面：切进来、从隐藏里回来、读完了盘。这时转录里有的字都是离开期间写下的，直接画出来，
 * 不当成刚到的一批去放——放的话，回来先看见离开时那一截，下一批字一到，攒下的几百上千字在几百毫秒里
 * 一口气刷出来。露面之后的第一帧起，再来的字照常放。由 `useArrival` 维护，`Conversation` 提供；
 * 别处没有这回事，恒为 false。
 */
export const Arrival = createContext<{ fresh: boolean }>({ fresh: false });

/** 换了 `key`（会话、读盘状态）、头一次挂上、或者从 `Activity` 的隐藏里回来，到下一帧之前都算刚露面。 */
export function useArrival(key: string): { fresh: boolean } {
	const arrival = useRef({ key, fresh: true }).current;
	if (arrival.key !== key) {
		arrival.key = key;
		arrival.fresh = true;
	}
	/*
	 * 回来时攒下的字不在露面的那次提交里：藏着的页面不跟 store 同步，订阅重新挂上才补进来，那是紧跟着
	 * 的另一次提交（见 `RetainedViews` 的 `finishReplayedAnimations`）。两次都在第一帧之前，所以撑到
	 * 下一帧；藏起来的那一刻就置上，露面那次提交里子组件的 effect 先于这里跑，也看得到。
	 */
	useEffect(() => {
		if (!arrival.fresh) return;
		const frame = requestAnimationFrame(() => {
			arrival.fresh = false;
		});
		return () => cancelAnimationFrame(frame);
	});
	useEffect(
		() => () => {
			arrival.fresh = true;
		},
		[arrival],
	);
	return arrival;
}

/**
 * 正在演的那一段：重挂上来的同一段（原文以它为开头、还没演完）接过同一条时间线。
 * 只记一份，同时在演的另一段对不上开头。
 */
let playing: { text: string; pace: Pace } | null = null;

function resumable(text: string, live: boolean): Pace | null {
	if (!playing || !text.startsWith(playing.text)) return null;
	if (!live && playing.pace.done + FADE <= performance.now()) return null;
	return playing.pace;
}

interface State {
	pace: Pace;
	target: string;
	cut: number;
	live: boolean;
	active: boolean;
	frame: number;
	linger: number;
}

export function useSmoothText(
	text: string,
	live: boolean,
): {
	text: string;
	active: boolean;
	/** 最近 `FADE` 毫秒内放出来的字数（UTF-16 单元）：新挂上的 `FadeText` 据此分辨哪些字是刚到的。 */
	recent: number;
} {
	const motion = !motionReduced();
	const arrival = useContext(Arrival);
	const state = useRef<State | null>(null);
	if (!state.current) {
		const now = performance.now();
		// 刚露面时也不接别处的时间线：被挤出去又挂回来的那一段，旧时间线只排到离开时的长度。
		const adopted = motion && !arrival.fresh ? resumable(text, live) : null;
		const pace = adopted ?? new Pace();
		if (!adopted) {
			if (live && motion && !arrival.fresh && text.length <= REPLAY) pace.plan(now, text.length);
			else pace.present(text.length, now);
		}
		const active = motion && (live || pace.cut(now) < text.length || pace.done + FADE > now);
		state.current = { pace, target: text, cut: active ? pace.cut(now) : text.length, live, active, frame: 0, linger: 0 };
	}
	const here = state.current;
	const [shown, setShown] = useState(() => here.target.slice(0, here.cut));
	const [active, setActive] = useState(here.active);

	useEffect(() => {
		const now = performance.now();
		here.live = live;
		clearTimeout(here.linger);

		const settle = () => {
			here.linger = window.setTimeout(() => {
				here.active = false;
				setActive(false);
			}, Math.max(0, here.pace.done - performance.now()) + FADE + 40);
		};

		// 没在演、不是往后接着写（换了一段原文）、或者长出来的是离开期间写的：直接给全文。
		if (!motion || !text.startsWith(here.target) || (arrival.fresh && text !== here.target)) {
			here.pace = new Pace();
			here.pace.present(text.length, now);
			here.target = text;
			here.cut = text.length;
			setShown(text);
			here.active = live && motion;
			setActive(here.active);
			if (here.active) playing = { text, pace: here.pace };
			return;
		}

		if (text !== here.target) {
			here.pace.plan(now, text.length);
			here.target = text;
		}
		if (live) {
			playing = { text, pace: here.pace };
			if (!here.active) {
				here.active = true;
				setActive(true);
			}
		}
		if (!here.active) return;

		const step = (time: number) => {
			here.frame = 0;
			const cut = wordCut(here.target, here.pace.cut(time), holdsWord(time, here.pace.arrivedAt, here.live));
			if (cut !== here.cut) {
				here.cut = cut;
				setShown(here.target.slice(0, cut));
			}
			if (cut >= here.target.length) {
				if (!here.live) settle();
				return;
			}
			here.frame = requestAnimationFrame(step);
		};
		if (here.cut >= text.length) {
			if (!live) settle();
			return;
		}
		here.frame = requestAnimationFrame(step);
	}, [text, live, motion, here, arrival]);

	/*
	 * 清理归自己的 effect 管，每次原文变了先停掉上一趟再起新的一趟。从前靠「`frame` 不为 0 就是还在跑」
	 * 跳过重复启动，而开发模式会把组件挂上、卸下、再挂上一遍：卸下那次取消了帧，`frame` 还留着旧的
	 * 编号，再挂上时以为循环还在，于是停在第一个字上再也不动。
	 */
	useEffect(
		() => () => {
			cancelAnimationFrame(here.frame);
			here.frame = 0;
			clearTimeout(here.linger);
		},
		[text, live, motion, here],
	);

	if (!active) return { text, active, recent: 0 };
	return { text: shown, active, recent: here.pace.recentCount(performance.now(), FADE) };
}
