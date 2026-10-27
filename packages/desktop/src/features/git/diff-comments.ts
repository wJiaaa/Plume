/**
 * 人在 Git 面板「改动」里逐行留给 agent 的评论。
 *
 * 按仓库存，不按会话：评论的是这份工作区里的改动，换个会话看同一个仓库，评过的那几行还标着。
 * 只放内存，和 `store/plan-review.ts` 一个道理：评论是一次审阅的草稿，发出去就清空；重启以后
 * 那些行多半已经被改过，留着只会标错地方。
 */

import { create } from "zustand";
import type { DiffHunk } from "@plume/core";
import { translate } from "../../i18n/translate.ts";

type DiffLine = DiffHunk["lines"][number];

export interface DiffComment {
	id: string;
	path: string;
	/**
	 * 评的那几行，留的时候什么样就存什么样。
	 *
	 * 发给模型的是这几行原文，不只是行号：留完评论到发出去之间文件还可能被改，行号会漂，原文能让它
	 * 认出说的是哪一段。界面上标记也按原文对（见 `rowKey`），对不上的那一行就不再标。
	 */
	lines: DiffLine[];
	text: string;
}

/**
 * 一行在 diff 里的身份：路径、哪一边的行号、这一行的字。
 *
 * 删掉的行只有旧行号，其余用新行号。字也算进去：文件被改过以后同一个行号上可能已经是别的内容，
 * 标在那里就是标错了地方。
 */
export function rowKey(path: string, line: DiffLine): string {
	const at = line.type === "remove" ? `-${line.oldLine ?? ""}` : `+${line.newLine ?? ""}`;
	return `${path}\0${at}\0${line.text}`;
}

interface DiffCommentState {
	/** 按仓库根目录。 */
	byRepo: Readonly<Record<string, readonly DiffComment[]>>;
	/** 带 `id` 就是改那一条（字和行都可能变：Shift 点能把它拉长），不带就是新加。 */
	save(cwd: string, comment: Omit<DiffComment, "id"> & { id?: string }): void;
	remove(cwd: string, id: string): void;
	clear(cwd: string): void;
}

function firstLine(comment: DiffComment): number {
	const line = comment.lines[0];
	return line?.newLine ?? line?.oldLine ?? 0;
}

export const useDiffComments = create<DiffCommentState>((set, get) => ({
	byRepo: {},
	save(cwd, comment) {
		const was = get().byRepo[cwd] ?? [];
		const next = comment.id
			? was.map((it) => (it.id === comment.id ? { ...it, ...comment, id: it.id } : it))
			: [...was, { ...comment, id: crypto.randomUUID() }];
		// 按文件、再按行排：序号和发出去的顺序都跟着读 diff 的顺序走，不跟着留的先后。
		next.sort((a, b) => a.path.localeCompare(b.path) || firstLine(a) - firstLine(b));
		set((state) => ({ byRepo: { ...state.byRepo, [cwd]: next } }));
	},
	remove(cwd, id) {
		const was = get().byRepo[cwd];
		if (!was) return;
		set((state) => ({ byRepo: { ...state.byRepo, [cwd]: was.filter((it) => it.id !== id) } }));
	},
	clear(cwd) {
		if (!get().byRepo[cwd]) return;
		set((state) => {
			const { [cwd]: _gone, ...rest } = state.byRepo;
			return { byRepo: rest };
		});
	},
}));

/** `src/a.ts:12-14`；只评了删掉的行时没有新行号，说明是改动前的第几行。 */
export function commentPlace(comment: Pick<DiffComment, "path" | "lines">): string {
	const range = (numbers: number[]) => {
		const low = Math.min(...numbers);
		const high = Math.max(...numbers);
		return low === high ? `${low}` : `${low}-${high}`;
	};
	const fresh = comment.lines.flatMap((line) => (line.type !== "remove" && line.newLine ? [line.newLine] : []));
	if (fresh.length > 0) return `${comment.path}:${range(fresh)}`;
	const old = comment.lines.flatMap((line) => (line.oldLine ? [line.oldLine] : []));
	return old.length > 0 ? translate("diffComment.removedAt", { path: comment.path, range: range(old) }) : comment.path;
}

/** 比代码里最长的一串反引号多一个，代码里本身带着 ``` 时围栏也不会提前合上。 */
function fenceFor(code: string): string {
	const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((run) => run[0].length));
	return "`".repeat(Math.max(3, longest + 1));
}

/**
 * 发给 agent 的那一条消息：每条评论是位置、那几行 diff、评论本身。
 *
 * diff 照 unified 的写法带 `+`/`-`/空格前缀：模型认得这个格式，也就分得清人评的是改之前还是改之后。
 * 序号写成 `(1)` 而不是 `1.`：每条中间夹着代码块，Markdown 列表到那里就断了，转录里每条都显示成「1.」。
 */
export function diffCommentPrompt(comments: readonly DiffComment[]): string {
	const parts = comments.map((comment, index) => {
		const code = comment.lines.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`).join("\n");
		const fence = fenceFor(code);
		return `(${index + 1}) \`${commentPlace(comment)}\`\n${fence}diff\n${code}\n${fence}\n${comment.text.trim()}`;
	});
	return [translate("diffComment.prompt"), ...parts].join("\n\n");
}
