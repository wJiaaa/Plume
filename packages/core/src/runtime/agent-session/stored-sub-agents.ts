/**
 * 一个会话派过的子代理，从日志读回来。
 *
 * 两处要它：`AgentSession` 打开时把上一个进程的子代理放回名单；没在跑的会话被点开看时，子代理面板
 * 也要有这份名单——点开一个会话只是为了看，不该为此起一套 agent（见 `stored-context.ts`）。两边读出
 * 的必须是同一份，否则同一个会话发一句话之后，面板上的子代理会变样。
 */

import { layerProjectSettings, resolveModel, type Settings } from "../../config/settings.ts";
import { rehydrateMessages } from "../../session/payload.ts";
import type { SessionStorage } from "../../session/storage.ts";
import type { SessionMeta } from "../../session/types.ts";
import type { SubAgentSummary } from "../../types/sub-agent.ts";
import type { ContextBreakdown } from "../record/context.ts";
import { SessionLog } from "../record/session-log.ts";
import { describeSubAgentContext, SubAgentContexts } from "../sub-agent/sub-agent-context.ts";
import { restoreSubAgents, type Rebuild, type RestoredSubAgent } from "../sub-agent/sub-agent-restore.ts";
import { SubAgentRegistry, type SubAgentDetail } from "../sub-agent/sub-agents.ts";
import { historyFrom } from "./session-turn.ts";

/** `settings` 是叠过项目层的那份：子代理按它当时跑的模型重建，而项目可以有自己的模型清单。 */
export async function readSubAgents(store: SessionStorage, meta: SessionMeta, settings: Settings): Promise<RestoredSubAgent[]> {
	// `then` rather than a bare call: a store that cannot answer at all throws before there is a promise to catch.
	const records = await Promise.resolve()
		.then(() => store.subAgentRecords(meta.id))
		.catch(() => []);
	if (records.length === 0) return [];
	// 落盘时挪出去的图片接回来，跟主会话的消息同一条路（`store.load`）。
	const said = records.flatMap((record) => (record.type === "event" && record.event.type === "subagent_message" && record.event.message ? [record.event.message] : []));
	const hydrated = await rehydrateMessages(said).catch(() => said);
	const back = new Map(said.map((message, index) => [message, hydrated[index] ?? message]));
	const readable = records.map((record) =>
		record.type === "event" && record.event.type === "subagent_message" && back.has(record.event.message)
			? { ...record, event: { ...record.event, message: back.get(record.event.message)! } }
			: record,
	);
	const fallback = resolveModel(settings, meta.modelId || settings.defaultModelId);
	const rebuild: Rebuild = (ran) => {
		// The model it ran on, so the prefix is the one it sent. Gone from settings: the session's, under no id, so `runSubAgent` strips the old handles.
		const provider = settings.providers.find((one) => one.enabled && one.id === ran.provider);
		const model = provider?.models.find((one) => one.modelId === ran.model);
		const using = provider && model ? { provider, model } : fallback;
		return using ? { model: provider && model ? model.id : "", history: (messages, boundary) => historyFrom(messages, boundary, using.provider, using.model) } : undefined;
	};
	return restoreSubAgents(readable, rebuild);
}

/** 没在跑的会话的子代理，只读：名单、单个的记录、单个的上下文读数，和跑着的会话答的一样。 */
export interface StoredSubAgents {
	list(): SubAgentSummary[];
	detail(id: string): SubAgentDetail | null;
	contextBreakdown(id: string): Promise<ContextBreakdown | null>;
}

export async function storedSubAgents(store: SessionStorage, sessionId: string, globalSettings: Settings): Promise<StoredSubAgents | null> {
	const meta = await store.get(sessionId);
	if (!meta) return null;
	const { settings } = await layerProjectSettings(globalSettings, meta.cwd);
	// 同一个登记簿，`list` / `detail` 的形状（含 `resumable`）就不会和跑着的会话两样。
	const registry = new SubAgentRegistry();
	registry.restore(await readSubAgents(store, meta, settings));
	const contexts = new SubAgentContexts();
	return {
		list: () => registry.list(),
		detail: (id) => registry.detail(id),
		async contextBreakdown(id) {
			const detail = registry.detail(id);
			if (!detail) return null;
			const seen = await contexts.get(id, () => store.read(sessionId));
			// 跑着的会话认的是此刻连着的 MCP 工具；没在跑的只有上一次请求记下的那份。
			const recorded = await new SessionLog(store, () => {}, meta).readContext();
			const parent = meta.parentId ? await store.get(meta.parentId) : null;
			return describeSubAgentContext({
				detail, seen, settings,
				fallback: resolveModel(settings, meta.modelId || parent?.modelId || settings.defaultModelId || "")?.model,
				mcpNames: new Set(recorded?.mcpTools ?? []),
			});
		},
	};
}
