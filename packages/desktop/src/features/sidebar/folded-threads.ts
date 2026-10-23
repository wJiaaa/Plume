/**
 * 哪些会话把从它派生出去的后续会话收起来了。
 *
 * 和项目折叠一样放在列表之外：行随会话列表变化重建，状态放在行里，每发一条消息就会全部展开。
 * 存进 `localStorage`，收拾过的侧边栏下次启动还是收拾过的样子。会话删掉后 id 留在这里也无害，
 * 只是不该无限长，所以只留最近的 `KEEP` 个。
 */

import { create } from "zustand";

const KEY = "ly-folded-threads";
const KEEP = 200;

function read(): string[] {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
		return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

function write(folded: string[]): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(folded));
	} catch {
		// 存不下丢的只是下次启动的记忆，这一次的折叠照样生效。
	}
}

interface FoldedThreads {
	folded: string[];
	setFolded: (id: string, folded: boolean) => void;
}

export const useFoldedThreads = create<FoldedThreads>((set, get) => ({
	folded: read(),
	setFolded: (id, folded) => {
		const rest = get().folded.filter((at) => at !== id);
		const next = folded ? [...rest, id].slice(-KEEP) : rest;
		if (next.length === get().folded.length && folded === get().folded.includes(id)) return;
		set({ folded: next });
		write(next);
	},
}));
