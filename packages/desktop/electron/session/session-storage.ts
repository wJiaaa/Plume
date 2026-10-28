import type { SessionStorage } from "@plume/core";
import type { SessionChange } from "@plume/contract";

/** 消息记录引起的列表变化最多隔这么久推一次，见 `observeSessionStorage`。 */
export const SETTLE_MS = 250;

/** Observe committed writes at the shared IPC/RPC boundary, including cold sessions. */
export function observeSessionStorage(store: SessionStorage, announce: (change: SessionChange) => void): SessionStorage {
	/*
	 * 消息记录引起的变化，每个会话最多 `SETTLE_MS` 推一次：第一条立刻推，之后的并成一条带最新 meta 的。
	 *
	 * 每写一条记录 `seq`、`updatedAt` 就换新，一批六个并行工具是十几条消息记录、十几次广播，每次窗口都把整张
	 * 会话列表重排一遍，侧边栏、顶栏、分屏跟着重画——量到每秒约 11 次。消息记录给列表带来的只有排序，晚
	 * 一点没人分得出。标题、模型、归档、挪动、截断、删除是列表上看得见的事，照旧立刻推，并作废这个会话
	 * 还没推出去的那条：删掉之后再推一条旧的，会把会话放回侧边栏。
	 */
	const held = new Map<string, { timer: ReturnType<typeof setTimeout>; change: SessionChange | null }>();
	const settle = (id: string) => {
		const slot = held.get(id);
		held.delete(id);
		if (slot?.change) gathered(slot.change);
	};
	const gathered = (change: SessionChange) => {
		const slot = held.get(change.id);
		if (slot) {
			slot.change = change;
			return;
		}
		announce(change);
		held.set(change.id, { change: null, timer: setTimeout(() => settle(change.id), SETTLE_MS) });
	};
	const changed = (change: SessionChange) => {
		const slot = held.get(change.id);
		if (slot) clearTimeout(slot.timer);
		held.delete(change.id);
		announce(change);
	};
	return {
		async create(...args) {
			const meta = await store.create(...args);
			changed({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		async append(...args) {
			const meta = await store.append(...args);
			// Token updates already travel over the agent stream; only directory changes need a push.
			// Null is a write that landed after its session was deleted: announcing it would put the session back in the sidebar.
			if (!meta || args[1].type === "event") return meta;
			(args[1].type === "message" ? gathered : changed)({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		async setArchived(...args) {
			const meta = await store.setArchived(...args);
			if (meta) changed({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		/*
		 * 推出去的 `projectId` 是**新**的那个，这正是侧边栏据以换组的依据：收到的一方按 id 找到
		 * 原来那条、整条换成这一份（见渲染层的 `applySessionChange`），于是它就从旧项目底下消失、
		 * 在新项目底下出现。
		 */
		async move(...args) {
			const meta = await store.move(...args);
			if (meta) changed({ id: meta.id, projectId: meta.projectId, meta });
			return meta;
		},
		async truncateFrom(...args) {
			const result = await store.truncateFrom(...args);
			if (result) changed({ id: result.meta.id, projectId: result.meta.projectId, meta: result.meta });
			return result;
		},
		async delete(id) {
			const meta = await store.get(id);
			await store.delete(id);
			if (meta) changed({ id, projectId: meta.projectId, meta: null });
		},
		async deleteMany(ids) {
			const gone = (await Promise.all(ids.map((id) => store.get(id)))).filter((meta) => meta !== null);
			await store.deleteMany(ids);
			for (const meta of gone) changed({ id: meta.id, projectId: meta.projectId, meta: null });
		},
		get: (...args) => store.get(...args),
		read: (...args) => store.read(...args),
		messages: (...args) => store.messages(...args),
		subAgentRecords: (...args) => store.subAgentRecords(...args),
		/*
		 * Opening a conversation can commit the reply a dead writer left behind (`settlePartial`).
		 * That changes its meta inside the store, where no wrapper sees a write, so the sidebar is told
		 * here — by the one read that opening a conversation always goes through.
		 */
		async load(...args) {
			const before = await store.get(args[0]);
			const loaded = await store.load(...args);
			if (loaded && before && loaded.meta.seq !== before.seq) changed({ id: loaded.meta.id, projectId: loaded.meta.projectId, meta: loaded.meta });
			return loaded;
		},
		listSessions: (...args) => store.listSessions(...args),
		// Startup maintenance runs before clients connect.
		pruneEmpty: (...args) => store.pruneEmpty(...args),
		// Streaming a reply and the settings pages' reads change nothing the sidebar shows.
		beginPartial: (...args) => store.beginPartial(...args),
		appendPartial: (...args) => store.appendPartial(...args),
		dropPartial: (...args) => store.dropPartial(...args),
		openCall: (...args) => store.openCall(...args),
		markCall: (...args) => store.markCall(...args),
		saveCallOutput: (...args) => store.saveCallOutput(...args),
		recordUsage: (...args) => store.recordUsage(...args),
		readSpend: (...args) => store.readSpend(...args),
		storeId: () => store.storeId(),
		activeDays: () => store.activeDays(),
		replyTimings: () => store.replyTimings(),
		usageCursors: () => store.usageCursors(),
		usageRecords: (sessionId, afterSeq) => store.usageRecords(sessionId, afterSeq),
		sizes: () => store.sizes(),
		exportTo: (path) => store.exportTo(path),
		sessionsWithResultOf: (toolName) => store.sessionsWithResultOf(toolName),
	};
}
