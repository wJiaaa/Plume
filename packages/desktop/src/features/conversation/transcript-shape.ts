/**
 * 转录的形状——行（`runs`）、块（`turnBlocks`）、时间分隔、问题导航——每拍只重算最后一轮。
 *
 * 流式时 `messages` 每拍换一个数组，而变的只有最后一条。四样从头算一遍是整个会话的量：九千条消息
 * 约 2.7ms，每拍一次。这里在最后一轮开头留一个检查点（`RunsCheckpoint`），前面那几轮的消息对象
 * 一个不差（按引用比）就从检查点接着算；结果和从头算逐项相同，`transcript-shape.test.ts` 拿随机转录对拍。
 *
 * 认不出来的时候一律从头算，宁可慢一拍：撤回截断、编辑替换让前面的消息换了对象；插话时前面那一轮的
 * 调用在后面才有结果；`live` 落回了前面那几轮的一行（只换那一块，见 `TurnBlocksCache`）。
 */

import type { CommandRun, Message } from "@plume/core";
import type { Hiccup } from "../../lib/hiccup.ts";
import { intact } from "../../lib/transcript.ts";
import { walkRuns, type Run, type RunsCheckpoint } from "./grouping.ts";
import { blocksFrom, opensBlock, withoutThinking, type BlockStart, type TurnBlock } from "./turn-blocks.ts";
import { opensTurn, resumesTurn } from "./turns.ts";
import { ask, separate, type Question } from "./question-navigation.ts";

/** 最后一轮从哪一条开始；没有就是 -1。 */
function lastTurnStart(messages: Message[]): number {
	for (let at = messages.length - 1; at > 0; at--) {
		if (opensTurn(messages[at]) && !resumesTurn(messages, at)) return at;
	}
	return -1;
}

/** `messages` 的 `[0, through]` 和 `kept` 是不是同一批对象。 */
function samePrefix(messages: Message[], kept: Message[], through: number): boolean {
	if (messages.length <= through || kept.length <= through) return false;
	for (let at = 0; at <= through; at++) if (messages[at] !== kept[at]) return false;
	return true;
}

function sameMarks<T extends { at: number }>(sorted: T[], kept: T[], at: number): boolean {
	for (let i = 0; i < kept.length; i++) if (sorted[i] !== kept[i]) return false;
	// 检查点之前消费掉的是 `at` 之前的标记；排在后面的那一个还得在 `at` 或之后。
	const next = sorted[kept.length];
	return next === undefined || next.at >= at;
}

const byAt = <T extends { at: number }>(list: T[]) => [...list].sort((a, b) => a.at - b.at);

/** `runs(messages, commands, hiccups)`，推理不画时再过一遍 `withoutThinking`。 */
export class RunsCache {
	private mark: RunsCheckpoint | null = null;
	private kept: Message[] = [];
	/** 检查点之前那几轮的每个调用：它们的结果出现在检查点之后时，前面的行要重算。 */
	private calls = new Set<string>();
	/** 检查点之前那几行过一遍 `withoutThinking` 的结果，跟着检查点走。 */
	private thin: { mark: RunsCheckpoint; rows: Run[] } | null = null;

	runs(rawMessages: Message[], commands: CommandRun[], hiccups: Hiccup[], showThinking: boolean): Run[] {
		const messages = intact(rawMessages);
		const turnAt = lastTurnStart(messages);
		let from = this.mark && turnAt >= this.mark.at && samePrefix(messages, this.kept, this.mark.at)
			&& sameMarks(byAt(commands), this.mark.commands, this.mark.at) && sameMarks(byAt(hiccups), this.mark.hiccups, this.mark.at)
			? this.mark
			: null;
		if (from && this.answersBefore(messages, from.at)) from = null;
		if (!from) this.forget();
		// 检查点没挪就不再留一个：留一次要把前面的行和调用表各复制一遍。
		const walked = walkRuns(messages, commands, hiccups, { from: from ?? undefined, mark: turnAt > 0 && turnAt !== from?.at ? turnAt : undefined });
		if (walked.mark) this.remember(messages, walked.mark);
		const mark = walked.mark ?? from;
		if (showThinking) return walked.rows;
		if (!mark) return withoutThinking(walked.rows);
		if (this.thin?.mark !== mark) this.thin = { mark, rows: withoutThinking(mark.rows) };
		return this.thin.rows.concat(withoutThinking(walked.rows.slice(mark.rows.length)));
	}

	private answersBefore(messages: Message[], at: number): boolean {
		for (let i = at; i < messages.length; i++) {
			const message = messages[i];
			if (message.role === "toolResult" && this.calls.has(message.toolCallId)) return true;
		}
		return false;
	}

	private forget(): void {
		this.mark = null;
		this.kept = [];
		this.calls = new Set();
		this.thin = null;
	}

	private remember(messages: Message[], mark: RunsCheckpoint): void {
		const start = this.mark ? this.mark.at : 0;
		for (let i = start; i < mark.at; i++) {
			const message = messages[i];
			if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") this.calls.add(block.id);
		}
		this.mark = mark;
		this.kept = messages;
	}
}

/**
 * `turnBlocks(list, live)`。
 *
 * 和上一次的 `list` 从头比，前面一段是同一批行对象，就从那一段里最后一个开轮处接着分：块只在开轮处断，
 * 之前的块与后面无关（见 `blocksFrom`）。
 */
export class TurnBlocksCache {
	private list: Run[] = [];
	private blocks: TurnBlock[] = [];
	private starts: BlockStart[] = [];

	turnBlocks(list: Run[], live: boolean): TurnBlock[] {
		let same = 0;
		const limit = Math.min(list.length, this.list.length);
		while (same < limit && list[same] === this.list[same]) same++;
		/*
		 * 开轮那一行之前的行都没变，它之前的块就不变。那一行本身可以是新对象（最后一轮的行每拍都是新算的），
		 * 只要它还开轮。
		 */
		let from: BlockStart | undefined;
		for (let i = this.starts.length - 1; i >= 0; i--) {
			const at = this.starts[i].at;
			if (at < same || (at === same && at < list.length && opensBlock(list[at]))) {
				from = this.starts[i];
				break;
			}
		}
		const next = blocksFrom(list, live, from, this.blocks);
		const kept = from ? this.starts.slice(0, this.starts.indexOf(from)) : [];
		this.list = list;
		this.blocks = next.blocks;
		this.starts = kept.concat(next.starts);
		return next.blocks;
	}
}

/**
 * `timeSeparators` 与 `questionsIn`（`question-navigation.ts`）的接着算版本：同样在最后一轮开头留检查点。
 * 两者都是从头往后的一遍折叠，检查点就是折到那里时的状态。
 */
export class NavigationCache {
	private at = -1;
	private kept: Message[] = [];
	private separators = new Set<number>();
	private previous: number | undefined;
	private questions: Question[] = [];

	private resume(messages: Message[]): number {
		const turnAt = lastTurnStart(messages);
		if (this.at > 0 && turnAt >= this.at && samePrefix(messages, this.kept, this.at - 1)) {
			if (turnAt === this.at) return this.at;
			this.fold(messages, this.at, turnAt);
		} else {
			this.at = 0;
			this.separators = new Set();
			this.previous = undefined;
			this.questions = [];
			if (turnAt > 0) this.fold(messages, 0, turnAt);
		}
		this.at = turnAt > 0 ? turnAt : 0;
		this.kept = messages;
		return this.at;
	}

	/** 把 `[from, to)` 折进检查点。存着的问题对象此后不再改：后面的回答落到它身上时换一份。 */
	private fold(messages: Message[], from: number, to: number): void {
		const { separators, questions } = this;
		let previous = this.previous;
		for (let index = from; index < to; index++) {
			previous = separate(messages[index], index, previous, separators);
			ask(messages[index], index, questions);
		}
		this.previous = previous;
	}

	timeSeparators(messages: Message[]): Set<number> {
		const at = this.resume(messages);
		const result = new Set(this.separators);
		let previous = this.previous;
		for (let index = at; index < messages.length; index++) previous = separate(messages[index], index, previous, result);
		return result;
	}

	questionsIn(messages: Message[]): Question[] {
		const at = this.resume(messages);
		const questions = this.questions.slice();
		for (let index = at; index < messages.length; index++) ask(messages[index], index, questions);
		return questions;
	}
}
