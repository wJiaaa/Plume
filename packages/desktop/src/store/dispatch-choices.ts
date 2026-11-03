import { create } from "zustand";

/**
 * 侧边聊天里那张「交给谁做」的卡片（`dispatch_task` 没被点名主会话时），人选了哪一边。
 *
 * 开新会话那一项不记：新会话的 `spawnedFrom` 指回这次调用，从会话列表读，重启也对。交给主会话和
 * 在这里做只在这里记——和收起建议卡片一样（`session-suggestions.ts`），是这台机器上的事，按调用 id 存
 * localStorage；放进 store 是为了点下去那一刻卡片就收起来。
 */
export type DispatchChoice = "main" | "here";

const KEY = "plume.dispatchChoices";
/** 远多于一段侧边聊天会交出去的次数；超过就忘掉最早的。 */
const KEEP = 200;

function read(): Record<string, DispatchChoice> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, DispatchChoice] => entry[1] === "main" || entry[1] === "here"));
	} catch {
		return {};
	}
}

export const useDispatchChoices = create<{ chosen: Record<string, DispatchChoice> }>(() => ({ chosen: read() }));

function save(chosen: Record<string, DispatchChoice>): void {
	useDispatchChoices.setState({ chosen });
	try {
		localStorage.setItem(KEY, JSON.stringify(chosen));
	} catch {
		// 存不下就只在这次窗口里记着。
	}
}

/** 记下选择；`null` 是撤回（交给主会话没成，主会话起不来），卡片重新可点。 */
export function chooseDispatch(callId: string, choice: DispatchChoice | null): void {
	const { [callId]: _was, ...rest } = useDispatchChoices.getState().chosen;
	save(choice ? Object.fromEntries([...Object.entries(rest), [callId, choice]].slice(-KEEP)) : rest);
}
