import { stat } from "node:fs/promises";
import {
	projectConfigPath,
	storedContextBreakdown,
	storedSubAgents,
	type ContextBreakdown,
	type Message,
	type SessionStorage,
	type Settings,
	type SubAgentSummary,
} from "@plume/core";
import { deliveryMessages } from "./delivery-record.ts";

/*
 * 没在跑的会话从日志读出来的东西，一个会话一份，日志动了（`seq`）就整份作废。
 *
 * 点开一个会话，上下文表、子代理名单、每一轮的交付卡片都要从日志答，而每一样都要把整份历史解析一遍——
 * 5MB 的会话在主进程上 15–30ms，切一次付一次。从前是三份缓存各管各的：读数 32 条、交付 32 条、
 * 整份历史单槽加 5 秒计时器，各有各的键和淘汰，读数那份还攥着整个子代理登记簿（每个子代理的完整转录）。
 * 合成一份以后，键只有一处，淘汰只有一处（最近用过的留下），常驻的只剩答案本身：
 *
 * - 整份历史只留几秒，给前后脚来问的那几个共用；
 * - 子代理只留名单（`list()` 的摘要），点开某一个的详情时再从日志读；
 * - 依赖设置的读数另外认设置对象和项目设置文件（`.plume/config.json`）：设置换了、项目设置改了而日志
 *   没动时，读数不能停在旧值上。
 *
 * 读失败的不留：下次再问重读，而不是一直错到日志动了为止。
 */

type Loaded = Awaited<ReturnType<SessionStorage["load"]>>;

/** 留多少个会话。 */
const SESSION_LIMIT = 32;
/** 所有会话加起来留多少轮交付的消息：一个长会话的每一轮都挂着交付卡片，按会话数封顶等于留下整份历史。 */
const TURN_LIMIT = 32;
/** 整份历史留多久：够首次点开时前后脚的几个问题共用，不够让一份 5MB 的消息常驻。 */
const HOLD_MS = 5000;

interface Readings {
	settings: Settings;
	project: string;
	context?: Promise<ContextBreakdown | null | undefined>;
	roster?: Promise<SubAgentSummary[] | null>;
}

interface Entry {
	seq: number;
	history?: Promise<Loaded>;
	turns: Map<number, Promise<Message[]>>;
	readings?: Readings;
}

const entries = new Map<string, Entry>();

/** 这个会话在这个 `seq` 上的那一份；日志动过就换一份新的。用到的挪到最后，淘汰从最前面开始。 */
function entryFor(sessionId: string, seq: number): Entry {
	const kept = entries.get(sessionId);
	entries.delete(sessionId);
	const entry = kept && kept.seq === seq ? kept : { seq, turns: new Map() };
	entries.set(sessionId, entry);
	if (entries.size > SESSION_LIMIT) entries.delete(entries.keys().next().value!);
	return entry;
}

/** 失败的那一次不留，留下的才是答案。 */
function forgetIfFailed<T>(reading: Promise<T>, forget: () => void): Promise<T> {
	reading.catch(forget);
	return reading;
}

function history(store: SessionStorage, sessionId: string, entry: Entry): Promise<Loaded> {
	if (entry.history) return entry.history;
	const reading = store.load(sessionId);
	entry.history = reading;
	const release = () => {
		if (entry.history === reading) entry.history = undefined;
	};
	setTimeout(release, HOLD_MS).unref();
	// 没读到（会话还没落盘、刚被删）和读失败一样不留，下一次重读。
	void reading.then((loaded) => loaded ?? release(), release);
	return reading;
}

function trimTurns(): void {
	let total = 0;
	for (const entry of entries.values()) total += entry.turns.size;
	for (const entry of entries.values())
		for (const at of entry.turns.keys()) {
			if (total <= TURN_LIMIT) return;
			entry.turns.delete(at);
			total--;
		}
}

/** 某一轮交付了什么——切出来的那一小段消息。文件现在什么样（能不能撤销）由调用方每次现查。 */
export function storedTurn(store: SessionStorage, sessionId: string, seq: number, timestamp: number): Promise<Message[]> {
	const entry = entryFor(sessionId, seq);
	const kept = entry.turns.get(timestamp);
	if (kept) return kept;
	const reading = history(store, sessionId, entry).then((loaded) => {
		if (!loaded) throw new Error("会话记录不存在");
		return deliveryMessages(loaded.messages, timestamp);
	});
	entry.turns.set(timestamp, reading);
	trimTurns();
	return forgetIfFailed(reading, () => {
		if (entry.turns.get(timestamp) === reading) entry.turns.delete(timestamp);
	});
}

/** 项目设置文件此刻的样子。改了就换一个值；没有这个文件也是一种样子。 */
async function projectStamp(cwd: string | undefined): Promise<string> {
	if (!cwd) return "";
	const file = await stat(projectConfigPath(cwd)).catch(() => null);
	return file ? `${file.mtimeMs}:${file.size}` : "-";
}

async function readingsFor(store: SessionStorage, sessionId: string, settings: Settings): Promise<{ entry: Entry; readings: Readings }> {
	const meta = await store.get(sessionId);
	// 侧边聊天自己没选模型时用父会话的，父会话换了模型，它的日志不会动。
	const parent = meta?.parentId && !meta.modelId ? await store.get(meta.parentId) : null;
	const project = `${await projectStamp(meta?.cwd)}|${parent?.modelId ?? ""}`;
	const entry = entryFor(sessionId, meta?.seq ?? -1);
	const kept = entry.readings;
	if (kept && kept.settings === settings && kept.project === project) return { entry, readings: kept };
	const readings: Readings = { settings, project };
	entry.readings = readings;
	return { entry, readings };
}

/** 上下文表的读数。`undefined` 是「日志答不了」，调用方照旧把会话拉起来（见 `storedContextBreakdown`）。 */
export async function storedContext(store: SessionStorage, sessionId: string, settings: Settings): Promise<ContextBreakdown | null | undefined> {
	const { entry, readings } = await readingsFor(store, sessionId, settings);
	if (readings.context) return readings.context;
	const reading = storedContextBreakdown(store, sessionId, settings, () => history(store, sessionId, entry));
	readings.context = reading;
	return forgetIfFailed(reading, () => {
		if (readings.context === reading) readings.context = undefined;
	});
}

/** 子代理名单。只留摘要：登记簿里每个子代理的完整转录用完即弃，详情按需另读（`storedSubAgents`）。 */
export async function storedRoster(store: SessionStorage, sessionId: string, settings: Settings): Promise<SubAgentSummary[] | null> {
	const { readings } = await readingsFor(store, sessionId, settings);
	if (readings.roster) return readings.roster;
	const reading = storedSubAgents(store, sessionId, settings).then((roster) => roster?.list() ?? null);
	readings.roster = reading;
	return forgetIfFailed(reading, () => {
		if (readings.roster === reading) readings.roster = undefined;
	});
}
