/**
 * 一个没在跑的会话的上下文读数，不把它拉起来。
 *
 * 输入框旁的上下文表一挂上就要这份读数，而点开一个会话只是为了看：起 agent 要加载技能和插件、
 * 连上每一台 MCP 服务器（见桌面端 `sessions:transcript` 那段）。读数其实用不着这些——日志里记着
 * 上一次真正发出去的 system prompt 和工具表（`context` 记录），活着的会话量的也正是那一份
 * （`describeContext`），再配上从日志还原的历史就够了。
 *
 * `undefined` 是「日志答不了」，交给调用方照旧把会话拉起来：从没发出过请求的（没有记录，只能现拼
 * 一份预览）和侧边聊天（模型跟着父会话走）。`null` 是「拉起来也量不出」：会话没了，或者当前设置里
 * 解析不出它那个模型——活着的会话这时也只会答 null，不值得为它起一套 agent。
 */

import { layerProjectSettings, resolveModel, type Settings } from "../../config/settings.ts";
import type { SessionStorage } from "../../session/storage.ts";
import type { ContextBreakdown } from "../record/context.ts";
import { describeRecordedContext } from "../record/reporting.ts";
import { SessionLog } from "../record/session-log.ts";
import { historyFrom } from "./session-turn.ts";

/** `load` lets a caller that already holds this session's history hand it over instead of parsing it again. */
export async function storedContextBreakdown(
	store: SessionStorage,
	sessionId: string,
	globalSettings: Settings,
	load: () => ReturnType<SessionStorage["load"]> = () => store.load(sessionId),
): Promise<ContextBreakdown | null | undefined> {
	const meta = await store.get(sessionId);
	if (!meta) return null;
	if (meta.parentId) return undefined;
	// 先找记录：只读 `context` 那几条，没有就不必把整份历史解析一遍。
	const recorded = await new SessionLog(store, () => {}, meta).readContext();
	if (!recorded) return undefined;
	const loaded = await load();
	if (!loaded) return null;
	// 和 `AgentSession` 一样叠上项目层：项目可以有自己的模型清单。
	const { settings } = await layerProjectSettings(globalSettings, loaded.meta.cwd);
	const resolved = resolveModel(settings, loaded.meta.modelId || settings.defaultModelId || "");
	if (!resolved) return null;
	const messages = historyFrom(loaded.messages, loaded.compaction, resolved.provider, resolved.model);
	return describeRecordedContext(recorded, messages, resolved.model);
}
