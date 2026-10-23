/**
 * 撤回时一并拿回的文件：被截掉的那几轮改过的、Plume 记下了改动的那些。
 *
 * 全有或全无，和 ZCode 的文件回退一样：一个文件之后被别的会话或人改过、改动来自命令、或者有记录读不出来，
 * 就一个文件都不写——只拿回一部分，代码停在一个从没存在过的中间状态，比不拿回更糟。被别人改过的文件
 * 不覆盖、不合并，交给人。
 */

import { undoFileChangeBatches, undoProblems, type AgentSession } from "@plume/core";
import type { RevertPlan } from "@plume/contract";
import { nativeText } from "../i18n.ts";
import { changedFiles, recordedChanges } from "./delivery-record.ts";

/** 截掉的那段里每个文件的改动；改了又改回原样的不算，和交付卡片按同一个判断（`changedFiles`）。 */
async function cutChanges(session: AgentSession, index: number): Promise<{ files: ReturnType<typeof changedFiles>; unrecorded: boolean }> {
	const { groups, warnings } = await recordedChanges(session.meta.id, session.messages.slice(index));
	return { files: changedFiles(groups), unrecorded: warnings.length > 0 };
}

export async function revertPlan(session: AgentSession, index: number): Promise<RevertPlan> {
	const { files, unrecorded } = await cutChanges(session, index);
	const problems = await undoProblems(session.meta.cwd, files.map((file) => file.changes));
	return {
		files: files.map(({ path, diff }, i) => ({ path, added: diff.added, removed: diff.removed, problem: problems[i] })),
		unrecorded,
	};
}

/**
 * 写回去；不能全部写回就抛错、什么都不动。
 *
 * 不重用确认框看到的那份演算：从按下确认到这里，别的会话可能又写了一次，`undoFileChangeBatches` 写之前
 * 自己再查一遍，写到一半失败会把已写的退回去。
 */
export async function restoreRevertedFiles(session: AgentSession, index: number): Promise<void> {
	const { files, unrecorded } = await cutChanges(session, index);
	if (unrecorded) throw new Error(nativeText("revert.unrecorded"));
	if (files.length) await undoFileChangeBatches(session.meta.cwd, files.map((file) => file.changes));
}
