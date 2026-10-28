import { create } from "zustand";
import type { PeerLetter } from "@plume/core";

/**
 * 每个会话里，别的会话发来、插进这一轮还没读到的请求。
 *
 * 它们在下一步之前才进转录：这之前屏幕上一个字没有，看不出有人在等这个会话。
 * `apply-event.ts` 按 `peer_queue` 事件写，事件每次带整张表。窗口重载时没听到过的那一张拿不回来，
 * 下一次到信或读信会带来准数——它们只活在一步之内，没有为此补一次查询。
 */

export const usePeerQueue = create<{ bySession: Record<string, PeerLetter[]> }>(() => ({ bySession: {} }));

export function setPeerQueue(sessionId: string, letters: PeerLetter[]): void {
	usePeerQueue.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: letters } }));
}
