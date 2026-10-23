/**
 * 交给审阅会话的那份交接单：原会话填的字段、运行时附的原文，排成审阅会话的第一条消息。
 *
 * 写成必填字段、逐项卡长度，而不是一段自由的「实现总结」：一段总结模型一句话就能打发，而审阅者缺的正是
 * 那一句话没说的前因后果。缺哪项、哪项太短，退回去点名，让它补齐重发。
 *
 * 计划和用户原话由这里从记录里取原文，不让模型转述：转述会被改写、截短，漏写的约束审阅者就无从知道。
 * 排版照着任务说明的顺序——你是谁、背景、决定与原话、计划、实现、文件、不做的、没验证的、重点、目标、交付——
 * 审阅会话读完就知道要做什么、以什么为准。见 ADR-0058。
 */

import { REVIEW_SESSION_OPENING, type Message } from "@plume/core";
import type { ReviewHandoff, ReviewSessionDetails } from "../../shared/session-suggestion.ts";
import { nativeText } from "../i18n.ts";

/**
 * 每项的最短长度，按字数（码点）算。下限只为挡住一句话打发：背景和实现说明少于一两句话就说不清前因
 * 后果；决定和未验证允许「用户没有额外约束」「没有已知未验证的地方」这样明写的「没有」，但不收「无」。
 */
const MIN = { background: 40, decisions: 8, implementation: 40, unverified: 6, change: 4 } as const;
/** 一项写得再细也装得下；再长就是把 diff 或对话贴了进来，那两样审阅会话自己有。 */
const FIELD_MAX = 8_000;
const FILES_MAX = 200;

/**
 * 附上的用户原话总共多少字。
 *
 * 一万二千字大约三到六千 token：真实会话里人说的话很少超过它，超过的多半是贴进来的日志或文档；再多
 * 就开始挤审阅会话读 diff 的上下文。超了保留最早一条（最初的需求）和最近几条（最后的改口），中间写明省略
 * 了几条。单条先截到三千字，免得一条贴进来的长日志挤掉其余所有的话。
 */
const WORDS_MAX = 12_000;
const WORD_MAX = 3_000;

type Args = Record<string, unknown>;
const length = (text: string) => [...text].length;

function clipWord(text: string): string {
	const points = [...text];
	return points.length > WORD_MAX ? `${points.slice(0, WORD_MAX).join("")}…` : text;
}

/** 一项文字：缺了或太短就记进 `missing`，太长就是错。 */
function text(args: Args, key: string, min: number, missing: string[], errors: string[]): string | undefined {
	const value = args[key];
	if (value !== undefined && typeof value !== "string") {
		errors.push(`${key} must be text.`);
		return undefined;
	}
	const trimmed = (value ?? "").trim();
	if (length(trimmed) < min) {
		if (min > 0) missing.push(`${key} (${trimmed ? `${length(trimmed)} characters, at least ${min}` : "missing"})`);
		return undefined;
	}
	if (length(trimmed) > FIELD_MAX) errors.push(`${key} is ${length(trimmed)} characters; keep it to ${FIELD_MAX}.`);
	return trimmed || undefined;
}

function files(value: unknown, missing: string[], errors: string[]): ReviewHandoff["files"] {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) {
		missing.push("files (missing: list each changed file with one sentence on what changed)");
		return [];
	}
	if (!Array.isArray(value)) {
		errors.push("files must be a list of { path, change }.");
		return [];
	}
	if (value.length > FILES_MAX) errors.push(`files has ${value.length} entries; keep it to ${FILES_MAX}.`);
	const result: ReviewHandoff["files"] = [];
	value.forEach((entry: unknown, at) => {
		const one = (typeof entry === "object" && entry !== null ? entry : {}) as Args;
		const path = typeof one.path === "string" ? one.path.trim() : "";
		const change = typeof one.change === "string" ? one.change.trim() : "";
		if (!path) missing.push(`files[${at}].path (missing)`);
		else if (length(change) < MIN.change) missing.push(`files[${at}].change for ${path} (${change ? `${length(change)} characters, at least ${MIN.change}` : "missing"})`);
		else result.push({ path, change });
	});
	return result;
}

/**
 * 交接单，或者一句说给模型听的错误：一次列出所有缺的、太短的，让它一次补齐。
 * 审 PR 时没有实现可交接，一项都不填是对的；填了任何一项就按全套校验，免得交一半。
 */
export function reviewHandoff(args: Args, pullRequest: boolean): ReviewHandoff | undefined | { error: string } {
	const keys = ["background", "decisions", "implementation", "files", "out_of_scope", "unverified", "focus"];
	if (pullRequest && keys.every((key) => args[key] === undefined)) return undefined;
	const missing: string[] = [];
	const errors: string[] = [];
	const background = text(args, "background", MIN.background, missing, errors);
	const decisions = text(args, "decisions", MIN.decisions, missing, errors);
	const implementation = text(args, "implementation", MIN.implementation, missing, errors);
	const changed = files(args.files, missing, errors);
	const outOfScope = text(args, "out_of_scope", 0, missing, errors);
	const unverified = text(args, "unverified", MIN.unverified, missing, errors);
	const focus = text(args, "focus", 0, missing, errors);
	if (errors.length > 0) return { error: errors.join(" ") };
	if (missing.length > 0 || !background || !decisions || !implementation || !unverified) {
		return {
			error:
				`The hand-off is incomplete — missing or too short: ${missing.join("; ")}. ` +
				"The review session knows nothing but what you write here, so fill these in fully and call again: quote the person's own words in decisions, and write explicitly when there is none (\"The person set no further constraints\", \"Nothing known unverified\").",
		};
	}
	return { background, decisions, implementation, files: changed, ...(outOfScope ? { outOfScope } : {}), unverified, ...(focus ? { focus } : {}) };
}

/** 人在这一条里说的话：点名技能的那条照人打的样子写回 `/名字 参数`，图片之类没有字的不算。 */
function spoken(message: Extract<Message, { role: "user" }>): string {
	if (message.skillRef) return `/${message.skillRef.name}${message.displayText ? ` ${message.displayText}` : ""}`.trim();
	if (message.displayText !== undefined) return message.displayText.trim();
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
}

/**
 * 用户在原会话里说过的话，按时间顺序，原文。合成的（交回的报告、别的会话的信、定时唤醒、压缩摘要）不是人说的，不算。
 * 超过 `WORDS_MAX` 时保留最早一条和放得下的最近几条，`omitted` 是中间省略的条数。
 */
export function userWords(messages: readonly Message[]): { words: { n: number; text: string }[]; omitted: number } {
	const all = messages
		.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user" && !message.synthetic)
		.map(spoken)
		.filter(Boolean)
		.map((said, at) => ({ n: at + 1, text: clipWord(said) }));
	const total = all.reduce((sum, one) => sum + length(one.text), 0);
	if (total <= WORDS_MAX || all.length <= 2) return { words: all, omitted: 0 };
	const [first] = all;
	let room = WORDS_MAX - length(first.text);
	const recent: typeof all = [];
	// 最近的那一条总在：首条和它都截过，加起来不超过上限。
	for (let at = all.length - 1; at > 0; at--) {
		const size = length(all[at].text);
		if (recent.length > 0 && size > room) break;
		recent.unshift(all[at]);
		room -= size;
	}
	return { words: [first, ...recent], omitted: all.length - 1 - recent.length };
}

/**
 * 审阅会话的第一条消息。第一行让它认出自己（`/review` 正文第 0 步）；之后每一节都在，没填的写「未提供」，
 * 审阅者看得出是没有，而不是漏排了。计划、原话包在标签里（`<approved_plan>`、`<user_messages>`）：那是原文，边界要清楚。
 */
export function reviewPrompt(details: ReviewSessionDetails, plan: string | null, messages: readonly Message[], parentTitle: string, parentAddress: string): string {
	const none = nativeText("review.none");
	const handoff = details.handoff;
	const { words, omitted } = userWords(messages);
	const said = words.map((one, at) => {
		const gap = omitted > 0 && at === 1 ? `${nativeText("review.wordsOmitted", { n: omitted })}\n\n` : "";
		return `${gap}<user_message n="${one.n}">\n${one.text}\n</user_message>`;
	});
	const args = [details.target, details.effort ? `--effort ${details.effort}` : ""].filter(Boolean).join(" ");
	const section = (key: Parameters<typeof nativeText>[0], body: string) => `## ${nativeText(key)}\n\n${body}`;
	return [
		REVIEW_SESSION_OPENING,
		section("review.section.role", nativeText("review.brief", { title: parentTitle })),
		section("review.section.background", handoff?.background ?? none),
		section(
			"review.section.decisions",
			[
				`### ${nativeText("review.section.decisionsByAuthor")}\n\n${handoff?.decisions ?? none}`,
				`### ${nativeText("review.section.userWords")}\n\n${nativeText("review.wordsNote")}\n\n${said.length > 0 ? `<user_messages>\n${said.join("\n\n")}\n</user_messages>` : none}`,
			].join("\n\n"),
		),
		section("review.section.plan", plan ? `<approved_plan>\n${plan}\n</approved_plan>` : nativeText("review.noPlan")),
		section("review.section.implementation", handoff?.implementation ?? none),
		section("review.section.files", handoff?.files.map((one) => `- \`${one.path}\` — ${one.change}`).join("\n") ?? none),
		section("review.section.outOfScope", handoff?.outOfScope ?? none),
		section("review.section.unverified", handoff?.unverified ?? none),
		section("review.section.focus", handoff?.focus ?? none),
		section("review.section.target", `Arguments: ${args || "none (the uncommitted local changes)"}\n\n${nativeText("review.pipeline")}`),
		section("review.section.deliver", nativeText("review.deliver", { title: parentTitle, address: parentAddress })),
	].join("\n\n");
}
