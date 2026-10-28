/**
 * 在 diff 上逐行留评论，攒够了一次交给 agent。
 *
 * 点行号评这一行；在行号上按住往下拖，或者按住 Shift 再点同一段里的另一行，评的是中间那一段。
 * 点一行已经评过的，打开的是那一条，可以改也可以删。评论本身存在 `diff-comments.ts`，这里管的是
 * 挑行、写和发。
 *
 * 评论框等松手才弹：它挂在选中那一段的下面，拖的时候就弹出来会盖住正要拖过去的那几行——Shift 点
 * 最初就是这样点不到下一行的，落点全落在了框上。
 *
 * 用 context 而不是一路传 props：`DiffView` 在改动、历史、分支、PR 四处都画，只有改动视图里评论
 * 有人接——那是 agent 还能接着改的东西。别处没有这个 provider，行号照旧是一段字。
 */

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { DiffHunk } from "@plume/core";

import { useScopedSessionId } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { ArrowUp, MessageSquare, Trash2 } from "../../ui/icons/index.ts";
import { Textarea } from "../../ui/inputs/NativeField.tsx";
import { Popover } from "../../ui/overlay/Popover.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { Text } from "../../ui/primitives/Text.tsx";
import { useApp } from "../../store/index.ts";
import { bridge } from "../../services/index.ts";
import { commentPlace, diffCommentPrompt, rowKey, useDiffComments, type DiffComment } from "./diff-comments.ts";

type DiffLine = DiffHunk["lines"][number];

/** 一行在哪条评论里：`n` 是那条的序号，`last` 时序号画在这一行上，`draft` 是正在写的那一段。 */
export interface DiffNote {
	n: number;
	last: boolean;
	draft: boolean;
}

export interface DiffRow {
	path: string;
	hunk: DiffHunk;
	lineIndex: number;
}

export interface DiffCommenting {
	noteOf(path: string, line: DiffLine): DiffNote | null;
	/** 在行号上按下。`extend` 是按着 Shift：从上一次点的那一行拉到这一行。 */
	press(row: DiffRow, anchor: HTMLElement, extend: boolean): void;
	/** 按着拖进了另一行的行号。 */
	enter(row: DiffRow, anchor: HTMLElement): void;
}

const Commenting = createContext<DiffCommenting | null>(null);

/** 这个 diff 能不能评论；不能时是 null。 */
export function useDiffCommenting(): DiffCommenting | null {
	return useContext(Commenting);
}

interface Draft {
	path: string;
	lines: DiffLine[];
	anchor: HTMLElement;
	/** 改的是已有的那一条。 */
	id?: string;
	/** 还按着没松手：行标着，评论框还不弹。 */
	picking: boolean;
}

const EMPTY: readonly DiffComment[] = [];

export function DiffCommentsProvider({ cwd, children }: { cwd: string; children: ReactNode }) {
	const { t } = useI18n();
	// 发给这块面板所在那一屏的会话，和面板里别的「交给 agent」一样，见 `GitPanel` 的 `screen`。
	const screen = useScopedSessionId();
	const comments = useDiffComments((state) => state.byRepo[cwd] ?? EMPTY);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [note, setNote] = useState("");
	const panelWindow = bridge.bootWindow?.kind === "panel";
	const [sending, setSending] = useState(false);
	const inFlight = useRef(false);
	/*
	 * 上一次点的是哪一行，Shift 点的时候从它拉到这一行；`dragFrom` 是这一次按下去的起点。
	 *
	 * 不放在 `draft` 里：按下去的那一下先算「点在浮层外面」，浮层关掉时 `draft` 已经空了。按 hunk
	 * 对象比，不按序号：暂存和未暂存两组里可能是同一个文件，序号对得上、说的却不是同一段。
	 */
	const last = useRef<DiffRow | null>(null);
	const dragFrom = useRef<DiffRow | null>(null);

	const notes = useMemo(() => {
		const map = new Map<string, DiffNote>();
		comments.forEach((comment, index) => {
			comment.lines.forEach((line, at) => map.set(rowKey(comment.path, line), { n: index + 1, last: at === comment.lines.length - 1, draft: false }));
		});
		if (draft) {
			const n = draft.id ? comments.findIndex((comment) => comment.id === draft.id) + 1 : 0;
			draft.lines.forEach((line, at) => map.set(rowKey(draft.path, line), { n, last: n > 0 && at === draft.lines.length - 1, draft: true }));
		}
		return map;
	}, [comments, draft]);

	const commenting = useMemo<DiffCommenting>(() => {
		// 拉长的是手上这一条：写了一半的字留着，改的是哪一条也留着。
		const span = (from: DiffRow, row: DiffRow, anchor: HTMLElement) => {
			const low = Math.min(from.lineIndex, row.lineIndex);
			const high = Math.max(from.lineIndex, row.lineIndex);
			setDraft((was) => ({ path: row.path, lines: row.hunk.lines.slice(low, high + 1), anchor, picking: true, ...(was?.id ? { id: was.id } : {}) }));
		};
		return {
			noteOf: (path, line) => notes.get(rowKey(path, line)) ?? null,
			press(row, anchor, extend) {
				const line = row.hunk.lines[row.lineIndex];
				if (!line) return;
				const from = last.current;
				window.addEventListener("mouseup", () => {
					dragFrom.current = null;
					setDraft((was) => (was ? { ...was, picking: false } : was));
				}, { once: true });
				if (extend && from && from.hunk === row.hunk) {
					dragFrom.current = from;
					span(from, row, anchor);
					return;
				}
				last.current = row;
				dragFrom.current = row;
				const key = rowKey(row.path, line);
				const existing = comments.find((comment) => comment.path === row.path && comment.lines.some((it) => rowKey(comment.path, it) === key));
				if (existing) {
					setDraft({ path: existing.path, lines: existing.lines, anchor, id: existing.id, picking: true });
					setNote(existing.text);
					return;
				}
				setDraft({ path: row.path, lines: [line], anchor, picking: true });
				setNote("");
			},
			enter(row, anchor) {
				const from = dragFrom.current;
				if (from && from.hunk === row.hunk) span(from, row, anchor);
			},
		};
	}, [notes, comments]);

	const commit = () => {
		if (!draft || !note.trim()) return;
		useDiffComments.getState().save(cwd, { ...(draft.id ? { id: draft.id } : {}), path: draft.path, lines: draft.lines, text: note.trim() });
		setDraft(null);
	};

	const remove = () => {
		if (draft?.id) useDiffComments.getState().remove(cwd, draft.id);
		setDraft(null);
	};

	const send = async () => {
		if (inFlight.current || comments.length === 0 || (panelWindow && !screen)) return;
		inFlight.current = true;
		setSending(true);
		try {
			const prompt = diffCommentPrompt(cwd, comments);
			if (panelWindow && screen) {
				// 独立窗没有输入框，交给主进程确认接收；忙时排下一轮，不插进正在做的事。
				await bridge.agent.prompt(screen, [{ type: "text", text: prompt }], { deliver: "followUp" });
			} else {
				useApp.getState().setComposerDraft(prompt, { sessionId: screen, send: true });
			}
			// 只收走交出的那一份：等待确认时新写的、改过的评论还没发出去。
			const store = useDiffComments.getState();
			if (store.byRepo[cwd] === comments) store.clear(cwd);
			else {
				for (const comment of comments) {
					if (useDiffComments.getState().byRepo[cwd]?.includes(comment)) store.remove(cwd, comment.id);
				}
			}
			setDraft((was) => was === draft ? null : was);
		} catch (cause) {
			useApp.getState().notify(t("turn.sendFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
		} finally {
			inFlight.current = false;
			setSending(false);
		}
	};

	return (
		<Commenting.Provider value={commenting}>
			{children}

			{comments.length > 0 && (
				<div className="flex shrink-0 items-center gap-1 border-t border-line-soft py-1.5 pr-2 pl-3" data-diff-comment-bar="">
					<MessageSquare size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
					<Text size="label" tone="muted" className="ml-1 min-w-0 flex-1 truncate">
						{t("diffComment.count", { n: comments.length })}
					</Text>
					<Button size="sm" disabled={sending} onClick={() => useDiffComments.getState().clear(cwd)}>
						{t("common.clear")}
					</Button>
					<Button size="sm" variant="primary" icon={<ArrowUp size={13} strokeWidth={2} />} onClick={() => void send()} disabled={sending || (panelWindow && !screen)} data-diff-comment-send="">
						{t("diffComment.send")}
					</Button>
				</div>
			)}

			{draft && !draft.picking && (
				// 只关自己这一条：在别的行号上按下时，那一下先关掉这个框，新的那一条已经换上来了。
				<Popover anchor={draft.anchor} onClose={() => setDraft((was) => (was === draft ? null : was))} placement="bottom" align="start" width={320} surface="panel" role="dialog" label={t("diffComment.placeholder")}>
					<form className="flex flex-col gap-1 p-2" onSubmit={(event) => { event.preventDefault(); commit(); }}>
						<Text size="caption" tone="faint" mono className="truncate px-1.5">
							{commentPlace(draft)}
						</Text>
						<div className="flex items-end gap-1">
							<Textarea
								autoFocus
								rows={2}
								value={note}
								placeholder={t("diffComment.placeholder")}
								onChange={(event) => setNote(event.target.value)}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										commit();
									} else if (event.key === "Escape") {
										event.stopPropagation();
										setDraft(null);
									}
								}}
								className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-label text-ink placeholder:text-ink-faint focus:outline-none"
								data-diff-comment-input=""
							/>
							{draft.id && <IconButton size="sm" tone="danger" icon={<Trash2 size={13} strokeWidth={1.9} />} onClick={remove} label={t("diffComment.delete")} />}
							<IconButton size="sm" icon={<ArrowUp size={14} />} onClick={commit} label={t("diffComment.submit")} disabled={!note.trim()} />
						</div>
					</form>
				</Popover>
			)}
		</Commenting.Provider>
	);
}
