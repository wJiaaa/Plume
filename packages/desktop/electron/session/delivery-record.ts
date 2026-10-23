import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { computeDiff, formatDiff, plumeHome, readFileChange, undoProblems, type Message, type RecordedChange } from "@plume/core";
import type { TurnDelivery } from "@plume/contract";
export function deliveryMessages(messages: Message[], timestamp: number): Message[] {
	const end = messages.findIndex((message) => message.role === "assistant" && message.timestamp === timestamp);
	if (end < 0) throw new Error("找不到对应的回答");
	let start = end - 1;
	while (start >= 0) {
		const message = messages[start];
		if (message.role === "user" && !message.synthetic) break;
		start--;
	}
	return messages.slice(Math.max(0, start), end + 1);
}
/** The recorded file changes in these messages, per path in the order they were made. */
export async function recordedChanges(sessionId: string, messages: Message[]): Promise<{ groups: Map<string, RecordedChange[]>; warnings: string[] }> {
	const groups = new Map<string, RecordedChange[]>(), warnings: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const detail = message.details;
		if (!detail || typeof detail !== "object") continue;
		const ids = "changeIds" in detail && Array.isArray(detail.changeIds) ? detail.changeIds.filter((id): id is string => typeof id === "string") : [];
		if (!message.isError && "changeId" in detail && typeof detail.changeId === "string") ids.push(detail.changeId);
		for (const id of ids) {
			try { const change = await readFileChange(sessionId, id); const group = groups.get(change.path) ?? []; group.push(change); groups.set(change.path, group); }
			catch (error) { warnings.push(`变更快照不可用：${String(error)}`); }
		}
		if ("changeWarning" in detail && typeof detail.changeWarning === "string") warnings.push(detail.changeWarning);
	}
	return { groups, warnings };
}
/** The files these changes leave different, with that difference; one changed and changed back is not listed or undone anywhere. */
export function changedFiles(groups: Map<string, RecordedChange[]>): { path: string; changes: RecordedChange[]; diff: ReturnType<typeof computeDiff> }[] {
	return [...groups].map(([path, changes]) => ({ path, changes, diff: computeDiff(changes[0].before ?? "", changes[changes.length - 1].after ?? "") })).filter(({ diff }) => diff.added || diff.removed);
}
export async function collectDelivery(sessionId: string, cwd: string, messages: Message[], timestamp: number): Promise<TurnDelivery> {
	const { groups, warnings } = await recordedChanges(sessionId, messages);
	const value: TurnDelivery = { files: [], commands: [], serviceJobIds: [], warnings, reportPath: null };
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const detail = message.details;
		if (!detail || typeof detail !== "object") continue;
		if (!message.isError && "kind" in detail && detail.kind === "bash_background" && "id" in detail && typeof detail.id === "string") value.serviceJobIds.push(detail.id);
		if ("command" in detail && typeof detail.command === "string") {
			const status = "exitCode" in detail && typeof detail.exitCode === "number" ? `exit ${detail.exitCode}` : message.isError ? "失败或中断" : "已启动";
			value.commands.push({ command: detail.command, status, output: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") });
		}
	}
	const shown = changedFiles(groups);
	// The undo's own checks, so the button shows exactly when the undo would go through.
	const problems = await undoProblems(cwd, shown.map(({ changes }) => changes));
	shown.forEach(({ path, diff }, index) => value.files.push({ path, added: diff.added, removed: diff.removed, hunks: diff.hunks, canUndo: problems[index] === null }));
	const engineering = value.files.length > 0 || value.warnings.length > 0 || value.commands.some((entry) => /(?:^|[\s/])(?:test|check|lint|typecheck|pytest|jest|vitest|cargo|go)(?:[\s:]|$)/i.test(entry.command));
	if (!engineering) return value;
	const request = messages.filter((message) => message.role === "user" && !message.synthetic).flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n\n");
	const answer = messages.filter((message) => message.role === "assistant" && message.stopReason !== "toolUse").flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n\n");
	const report = [`# 本轮实现与验证记录`, `时间：${new Date(timestamp).toISOString()}`, `项目：${cwd}`, `## 用户需求`, request, `## Agent 交付说明`, answer,
		`## 实际文件变更`, ...value.files.map((file) => `- ${relative(cwd, file.path)}：+${file.added} −${file.removed}`),
		`## 命令与验证证据`, ...(value.commands.length ? value.commands.map((entry) => `### ${entry.status}\n\n~~~sh\n${entry.command}\n~~~\n\n~~~text\n${entry.output}\n~~~`) : ["本轮没有执行验证命令。"]),
		...(value.warnings.length ? ["## 未覆盖的记录", ...value.warnings] : []),
		`## 文件差异`, ...value.files.map((file) => `~~~diff\n${formatDiff({ added: file.added, removed: file.removed, hunks: file.hunks }, file.path, Infinity)}\n~~~`),
	].join("\n\n");
	// Session ids are supplied by the trusted transcript, but still cannot become path segments.
	const dir = join(plumeHome(), "scratch", encodeURIComponent(sessionId)); await mkdir(dir, { recursive: true });
	value.reportPath = join(dir, `delivery-${timestamp}.md`); await writeFile(value.reportPath, report, "utf8");
	return value;
}
