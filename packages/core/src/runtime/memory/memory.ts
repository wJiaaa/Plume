/**
 * Persistent memory engine: stores learned facts, preferences, user habits, and rules across sessions.
 * Similar to OpenAI / Codex local memory model, saved under ~/.plume/memory.json.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { plumeHome } from "../../session/store.ts";
import { writeFileAtomic } from "../../utils/atomic-write.ts";

export interface MemoryEntry {
	id: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	source?: "user" | "auto" | "session";
	sessionId?: string;
}

export interface MemoryStore {
	entries: MemoryEntry[];
}

export function memoryPath(): string {
	return join(plumeHome(), "memory.json");
}

/**
 * 读出来的记忆，以及它是不是可信的空。
 *
 * 文件不存在是真的空；读不出或解析不了是**不知道**里面有什么。两者从前都返回空，于是下一次增删把
 * `[新条目]` 整份写回，旧记忆一声不响全没了。注入照旧当成空（不能因为记忆坏了就开不了会话），写入
 * 要分开。
 */
async function readMemory(): Promise<{ store: MemoryStore; unreadable?: unknown }> {
	let raw: string;
	try {
		raw = await readFile(memoryPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { store: { entries: [] } };
		return { store: { entries: [] }, unreadable: error };
	}
	if (!raw.trim()) return { store: { entries: [] } };
	try {
		const parsed = JSON.parse(raw) as Partial<MemoryStore>;
		if (!Array.isArray(parsed.entries)) return { store: { entries: [] }, unreadable: new Error("entries is not a list") };
		return { store: { entries: parsed.entries } };
	} catch (error) {
		return { store: { entries: [] }, unreadable: error };
	}
}

export async function loadMemory(): Promise<MemoryStore> {
	return (await readMemory()).store;
}

/** 要改之前读：读不出就停下，不拿一个空列表去覆盖它。 */
async function loadForWrite(): Promise<MemoryStore> {
	const { store, unreadable } = await readMemory();
	if (unreadable) {
		const reason = unreadable instanceof Error ? unreadable.message : String(unreadable);
		throw new Error(`记忆文件 ${memoryPath()} 读不出来（${reason}），为免覆盖原有记忆，这次没有改动。修好或移走这个文件后再试。`);
	}
	return store;
}

/**
 * 会话内冻结的记忆注入快照，按会话 id 一条，内容由 `memory-inject.ts` 决定。
 *
 * 放在这里而不是 `memory-inject.ts`：人手动改记忆的几条路（这里的 `saveMemory`、
 * `project-memory.ts` 的几个 forget）要作废快照，而 `memory-inject.ts` 反过来依赖它们，
 * 放在最底层的这个模块里才不绕成环。
 */
export const memorySnapshots = new Map<string, unknown>();

/**
 * 人在设置里改了记忆：所有会话下一轮重新读。
 *
 * 冻结挡的是模型自己 `learn`、后台抽取这类会话中途的写入——那些改动模型已在历史里看到，或本来
 * 就不急。人删掉一条错的记忆是另一回事：他要的是它立刻不再被注入。
 */
export function invalidateMemorySnapshots(): void {
	memorySnapshots.clear();
}

async function saveMemory(store: MemoryStore): Promise<void> {
	const p = memoryPath();
	await mkdir(dirname(p), { recursive: true });
	const data = JSON.stringify({ entries: store.entries }, null, 2);
	// 整份替换：写到一半崩掉留下的是截断的 JSON，下一次读就是上面那种「不知道里面有什么」。
	await writeFileAtomic(p, data);
	invalidateMemorySnapshots();
}

/** 人在设置页里加的一条。`source` 里另外两种只出现在旧版本写下的数据里。 */
export async function addMemoryEntry(content: string): Promise<MemoryEntry> {
	const trimmed = content.trim();
	if (!trimmed) throw new Error("Memory content cannot be empty");
	const store = await loadForWrite();
	const entry: MemoryEntry = {
		id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		content: trimmed,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		source: "user",
	};
	store.entries.unshift(entry);
	await saveMemory(store);
	return entry;
}

export async function removeMemoryEntry(id: string): Promise<boolean> {
	const store = await loadForWrite();
	const initial = store.entries.length;
	store.entries = store.entries.filter((e) => e.id !== id);
	if (store.entries.length !== initial) {
		await saveMemory(store);
		return true;
	}
	return false;
}

export async function clearAllMemory(): Promise<void> {
	await saveMemory({ entries: [] });
}

/** Formats memory entries for insertion into the agent's system prompt. */
export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
	if (entries.length === 0) return "";
	const list = entries.map((e) => `- ${e.content}`).join("\n");
	return `<user_memory>\nRelevant user preferences, facts, and persistent memory learned across sessions:\n${list}\n</user_memory>`;
}
