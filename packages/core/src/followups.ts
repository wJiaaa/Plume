/**
 * 下一步建议：回复末尾的 `:followup[人接下来多半会说的那句]`，界面上不画，取出来当输入框的灰字。
 *
 * 取代过的做法是一轮收尾后再从主请求分叉一次，让模型「猜人下一句」。那次请求只看得到一条指令，
 * 被 20 字的上限和一串禁令压成「继续」「提交一下」；而写回复的那一刻，模型正清楚哪一步没验、给过
 * 哪几个选项。所以改成写回复时顺手写下来：不多一次请求，写得出完整、具体的一句。
 *
 * 提示词、解析、去标记都在这一个文件里，教给模型的写法就是认得出来的写法。不碰 Node：渲染进程从
 * `@plume/core/followups` 拿。
 */

export const FOLLOWUP_OPEN = ":followup[";

export interface Followup {
	prompt: string;
	/** 标记结束后的位置。 */
	end: number;
}

/**
 * 写进系统提示词的那一段。只给有输入框可填的端：桌面端的主会话。
 *
 * 「不写也行」放在最前：这段每次请求都在，模型容易把它读成「每条回复都要有」，于是收尾一律挂上
 * 「继续」。宁缺毋滥是这个功能能不能用的分界。
 */
export const FOLLOWUPS_PROMPT = `

Next step hint:
When your final reply of a turn leaves an obvious next step the user is likely to take, end it with one line:
:followup[what the user would send next]
It is not shown in your reply: the app puts it in the user's empty input box as a hint they can accept with Tab. Most replies need none; a generic one is worse than none.
- Take it from what this reply leaves open: a step not yet verified, the option they would most likely pick among those you offered, the next item of what they asked for.
- Write it as they would: one complete sentence in their language, specific enough to act on ("Run the login page e2e and paste the first failure", not "run the tests").
- Never: "continue", thanks or praise, things they did not ask about, or anything after a failure you have not explained.
- Only in the last reply of a turn, never in a reply that calls tools. Inside it, write \\] for a closing bracket.`;

/** `at` 处是不是一个写完了的标记。跨行的、方括号没收口的、空的都不算——那些照原样当字。 */
export function matchFollowup(source: string, at: number): Followup | null {
	if (!source.startsWith(FOLLOWUP_OPEN, at)) return null;
	let prompt = "";
	for (let i = at + FOLLOWUP_OPEN.length; i < source.length; i++) {
		const char = source[i];
		if (char === "\n" || char === "\r") return null;
		if (char === "\\" && i + 1 < source.length && source[i + 1] !== "\n") {
			prompt += source[++i];
			continue;
		}
		if (char === "]") return prompt.trim() ? { prompt: prompt.trim(), end: i + 1 } : null;
		prompt += char;
	}
	return null;
}

/** 一段回复里写完了的标记，按出现的顺序。代码块和行内代码里的不算：那是在讲这个写法。 */
export function followups(text: string): Followup[] {
	const found: Followup[] = [];
	scan(text, (followup) => found.push(followup));
	return found;
}

/**
 * 去掉标记：回复、复制，凡是给人看的地方都用这一份。
 *
 * 标记多半独占最后一行，去掉之后那一行整行拿掉、末尾的空行收掉，不然回复底下平白多出一段留白。
 * 只动有标记的那几行：别处行尾的两个空格是 Markdown 的硬换行。
 */
export function withoutFollowups(text: string): string {
	if (!text.includes(FOLLOWUP_OPEN)) return text;
	const cut: [number, number][] = [];
	scan(text, (followup, at) => cut.push([at, followup.end]));
	if (cut.length === 0) return text;
	const lines: string[] = [];
	let from = 0;
	let line = "";
	let touched = false;
	const close = () => {
		if (!touched) lines.push(line);
		else if (line.trim()) lines.push(line.trimEnd());
		line = "";
		touched = false;
	};
	for (const [start, end] of [...cut, [text.length, text.length] as [number, number]]) {
		const kept = text.slice(from, start).split("\n");
		kept.forEach((piece, index) => {
			if (index > 0) close();
			line += piece;
		});
		if (start < text.length) touched = true;
		from = end;
	}
	close();
	return lines.join("\n").trimEnd();
}

function scan(text: string, found: (followup: Followup, at: number) => void): void {
	if (!text.includes(FOLLOWUP_OPEN)) return;
	let i = 0;
	let lineStart = true;
	while (i < text.length) {
		if (lineStart) {
			const fence = /^[ \t]*(`{3,}|~{3,})/.exec(text.slice(i, i + 64));
			if (fence) {
				i = fenceEnd(text, i, fence[1]);
				continue;
			}
		}
		const char = text[i];
		lineStart = char === "\n";
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (char === "`") {
			let width = 1;
			while (text[i + width] === "`") width++;
			const close = text.indexOf("`".repeat(width), i + width);
			i = close >= 0 ? close + width : i + width;
			continue;
		}
		if (char === ":") {
			const followup = matchFollowup(text, i);
			if (followup) {
				found(followup, i);
				i = followup.end;
				continue;
			}
		}
		i++;
	}
}

/** 围栏收口那一行之后的位置；没收口就是全文末尾。 */
function fenceEnd(text: string, at: number, marker: string): number {
	const close = new RegExp(`^[ \\t]*${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
	let line = text.indexOf("\n", at);
	while (line >= 0) {
		const next = text.indexOf("\n", line + 1);
		if (close.test(text.slice(line + 1, next < 0 ? text.length : next))) return next < 0 ? text.length : next + 1;
		line = next;
	}
	return text.length;
}
