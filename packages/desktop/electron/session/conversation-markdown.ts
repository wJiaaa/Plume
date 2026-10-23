/**
 * 会话导出成一份给人读的 Markdown：说了什么、做了什么，不是调试用的轨迹。
 *
 * 和 `trajectory-export.ts` 的 `md` 不是一回事。那份每条记录一个代码块、带元数据，给排查用；这份
 * 只留人在界面上读得到的东西，而且比界面还省：
 *
 * - 思考不导出。界面上它也是折起来的，导出去的是这段对话的结论和经过。
 * - 工具调用一行一条，只写工具名和界面上那句摘要，输出一律不导出。一个跑过几十次命令的会话，
 *   日志能把一份导出撑到几 MB，而读的人要的是「它读了哪几个文件、跑了什么」，不是那几 MB。
 * - 子智能体只写它交回来的结论，内部的过程在它自己的面板里。
 *
 * 纯函数，读的是 `store.load` 投影好的消息（截断、撤回已经算过），不从原始记录再解析一遍。
 */

import type { AssistantMessage, Message, UserMessage } from "@plume/core";
import { restated } from "@plume/core/reply-text";
import { isAttachmentBody } from "../../src/lib/attachment-placeholders.ts";
import { routedMcpCall, summarizeToolCall } from "../../src/lib/tool-summary.ts";
import type { NativeMessageKey } from "../i18n.ts";

type Translate = (key: NativeMessageKey, variables?: Readonly<Record<string, string | number>>) => string;

export interface ConversationExport {
	title: string;
	cwd: string;
	messages: readonly Message[];
	/** 压缩发生在哪：它前面有几条消息（`store.load` 的 `compactions`）。 */
	compactions: readonly number[];
	exportedAt: Date;
	/** 「服务商/模型」用设置里起的名字；找不到就原样写 id，和换模型那条分隔线同一条规矩。 */
	modelLabel?: (provider: string, model: string) => string;
}

export function conversationMarkdown(input: ConversationExport, t: Translate): string {
	const label = input.modelLabel ?? ((provider: string, model: string) => `${provider}/${model}`);
	const { messages } = input;
	const results = new Map(messages.flatMap((message) => (message.role === "toolResult" ? [[message.toolCallId, message] as const] : [])));

	const models: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const name = label(message.provider, message.model);
		if (!models.includes(name)) models.push(name);
	}
	const head = [
		`# ${escapeInline(input.title.trim() || t("export.untitled"))}`,
		[
			`- ${t("export.exportedAt", { time: localTime(input.exportedAt) })}`,
			input.cwd ? `- ${t("export.project", { path: escapeInline(input.cwd) })}` : "",
			models.length ? `- ${t("export.models", { models: models.map(escapeInline).join(t("export.listSeparator")) })}` : "",
		].filter(Boolean).join("\n"),
	];

	const body: string[] = [];
	let speaker: "user" | "assistant" | null = null;
	let model: string | null = null;
	/** 连着的几次工具调用排成一张列表，不要每条之间空一行。 */
	let calls: string[] = [];
	const flush = () => {
		if (calls.length) body.push(calls.join("\n"));
		calls = [];
	};
	const say = (who: "user" | "assistant") => {
		if (speaker === who) return;
		flush();
		body.push(`## ${t(who === "user" ? "export.user" : "export.assistant")}`);
		speaker = who;
	};
	const divider = (text: string) => {
		flush();
		body.push(`*— ${escapeInline(text)} —*`);
		// 分隔之后是新的一段，下一句话重新标出是谁说的。
		speaker = null;
	};
	const compactions = [...input.compactions].sort((a, b) => a - b);
	let nextCompaction = 0;

	for (const [index, message] of messages.entries()) {
		while (nextCompaction < compactions.length && compactions[nextCompaction] <= index) {
			nextCompaction++;
			divider(t("export.compacted"));
		}
		if (message.role === "user") {
			if (message.delivery?.length) {
				flush();
				body.push(...delivered(message, t));
				speaker = null;
			} else if (message.peer?.length) {
				flush();
				for (const letter of message.peer) body.push(`### ${t("export.peer", { from: escapeInline(letter.from) })}`, quote(letter.text));
				speaker = null;
			} else if (!message.synthetic) {
				// 运行时替人说的话（自动继续、提示词更新、压缩的开头）界面上不画，这里也不写。
				const text = spoken(message);
				const files = attachmentNames(message, t);
				if (!text && !files.length) continue;
				say("user");
				if (text) body.push(closeOpenFence(text));
				if (files.length) body.push(t("export.attachments", { names: files.map(escapeInline).join(t("export.listSeparator")) }));
			}
			continue;
		}
		if (message.role === "toolResult") {
			const conclusion = syncConclusion(message);
			if (conclusion) {
				flush();
				body.push(quote(conclusion));
			}
			continue;
		}
		const name = label(message.provider, message.model);
		if (model !== null && model !== name) divider(t("export.modelSwitched", { from: model, to: name }));
		model = name;
		assistant(message, results, t, say, (line) => calls.push(line), body, flush);
	}
	while (nextCompaction++ < compactions.length) divider(t("export.compacted"));
	flush();

	if (!body.length) body.push(t("export.empty"));
	return `${[...head, ...body].join("\n\n")}\n`;
}

function assistant(
	message: AssistantMessage,
	results: ReadonlyMap<string, Message>,
	t: Translate,
	say: (who: "assistant") => void,
	call: (line: string) => void,
	body: string[],
	flush: () => void,
): void {
	let opened = false;
	const open = () => {
		if (!opened) say("assistant");
		opened = true;
	};
	for (const block of message.content) {
		if (block.type === "thinking") continue;
		if (block.type === "text") {
			// Responses 的最终答复会把同一条回复里的播报再说一遍，界面只画一遍，这里也只写一遍。
			if (!block.text.trim() || restated(block, message.content)) continue;
			open();
			flush();
			body.push(closeOpenFence(block.text.trim()));
			continue;
		}
		open();
		// 经 `mcp_call` 转手的按它真正叫的那个工具写，和对话里那张卡片同名。
		const routed = routedMcpCall(block.name, block.arguments ?? {});
		const summary = summarizeToolCall(routed.name, routed.args).replace(/\s+/g, " ").trim();
		const result = results.get(block.id);
		const failed = result?.role === "toolResult" && result.isError ? t("export.toolFailed") : "";
		call(`- ${inlineCode(routed.name)}${summary && summary !== routed.name ? ` ${escapeInline(summary)}` : ""}${failed}`);
	}
	if (message.stopReason === "error" && message.errorMessage) {
		open();
		flush();
		body.push(`*${escapeInline(t("export.replyFailed", { reason: message.errorMessage.replace(/\s+/g, " ").trim() }))}*`);
	}
}

/**
 * 人打的那句话。附件的正文是展开给模型读的，界面上不画，导出也不要。
 *
 * 调技能的那条，界面上是一枚技能胶囊加后面的字，`displayText` 只存后面的字——只打了 `/review` 的，
 * 它是空串。把胶囊写回成人打的 `/名字`，否则这条整个消失，后面的回答并进上一段「助手」里，读的人
 * 看不出是谁让它做的。
 */
function spoken(message: UserMessage): string {
	const skill = message.skillRef ? `/${message.skillRef.pluginId ? `${message.skillRef.pluginId}:` : ""}${message.skillRef.name}` : "";
	if (message.displayText !== undefined) return [skill, message.displayText.trim()].filter(Boolean).join(" ");
	return message.content
		.flatMap((block) => (block.type === "text" && !isAttachmentBody(block.text) ? [block.text] : []))
		.join("\n")
		.trim();
}

/**
 * 带了哪几份附件。图片一律按序号叫「图片 N」，和句子里那枚标记、和提示词里数的是同一个数；
 * 别的文件用真名，那是它唯一的辨认方式（见渲染进程的 `displayName`）。
 */
function attachmentNames(message: UserMessage, t: Translate): string[] {
	const names: string[] = [];
	let images = 0;
	for (const file of message.attachments ?? []) {
		if (!file || typeof file !== "object") continue;
		const image = file.kind === "image" || (file.kind === undefined && typeof file.mimeType === "string" && file.mimeType.startsWith("image/"));
		names.push(image ? t("export.image", { n: ++images }) : file.name);
	}
	// 老消息没有 `attachments`，只有图片块：照样数出来，少写一张比多写一张要命。
	const blocks = message.content.filter((block) => block.type === "image").length;
	while (images < blocks) names.push(t("export.image", { n: ++images }));
	return names;
}

const REPORT = /^<(subagent_result|session_result)\b[^>]*>\n([\s\S]*)\n<\/\1>$/;

/**
 * 后台跑完送回来的结果：子智能体交回的结论、建议开出去的会话交回的回复、结束了的后台命令。
 *
 * 结论只在给模型读的正文里，一份报告一个文本块（`delivery-message.ts`），这里把标签里的那段取出来；
 * 谁、干的什么从 `delivery` 上读，不去解析标签属性。后台命令只写一行，它的输出和工具输出一样不导出。
 */
function delivered(message: UserMessage, t: Translate): string[] {
	const out: string[] = [];
	const reports = { subagent_result: [] as string[], session_result: [] as string[] };
	for (const block of message.content) {
		const match = block.type === "text" ? REPORT.exec(block.text.trim()) : null;
		if (match) reports[match[1] as keyof typeof reports].push(match[2].trim());
	}
	let agents = 0;
	let sessions = 0;
	for (const report of message.delivery ?? []) {
		if (report.kind === "job") {
			const command = escapeInline(report.description || report.command || "");
			// `monitor` 的一批来自还在跑的命令：写成「命令结束」就说错了。
			const key = !report.monitor ? "export.jobFinished" : report.monitor.stopped ? "export.monitorStopped" : "export.monitorLines";
			out.push(`- ${t(key, { command, n: report.monitor?.lines ?? 0 })}`);
			continue;
		}
		if (report.kind === "wakeup") {
			out.push(`- ${t("export.wakeup", { reason: escapeInline(report.description) })}`);
			continue;
		}
		const text = report.kind === "session" ? reports.session_result[sessions++] : reports.subagent_result[agents++];
		const heading = report.kind === "session"
			? t("export.sessionResult", { title: escapeInline(report.description) })
			: t("export.subagentResult", { agent: escapeInline(report.agent || "agent"), task: escapeInline(report.description) });
		out.push(`### ${heading}`);
		if (text) out.push(quote(text));
	}
	return out;
}

/**
 * `task` 当场交回的结论。现在派出去都是转到后台的，当场交回的只是「已派出」那句话，结论另由送达带回；
 * 更早的会话里 `task` 会等到跑完，结论就在这条结果里。
 */
function syncConclusion(message: Extract<Message, { role: "toolResult" }>): string {
	if (message.toolName !== "task" || message.isError) return "";
	const details = message.details as { detached?: unknown } | undefined;
	if (details?.detached) return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
}

/** 引用块：每一行都要带 `>`，空行也是，否则一段多行的结论从第二段起就掉出引用。 */
function quote(text: string): string {
	return closeOpenFence(text.trim())
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * 写到一半断掉的回复会留下一个没合上的代码块，原样贴进去，它后面的整份导出都成了代码。合上它。
 *
 * 只认行首的 ``` 和 ~~~（最多三个空格缩进），合上用同一种字符、同样长，和 CommonMark 一样。
 * 正则里的反引号写成 `\x60`：字面量会让 `pnpm i18n` 的扫描把它当成模板字符串的开头。
 */
export function closeOpenFence(text: string): string {
	let open: string | null = null;
	for (const line of text.split("\n")) {
		const fence = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
		if (!fence) continue;
		const [, marks, rest] = fence;
		if (open === null) {
			// 反引号围栏的信息串里不能再有反引号，否则那一行不是围栏。
			if (marks[0] === "`" && rest.includes("`")) continue;
			open = marks;
		} else if (marks[0] === open[0] && marks.length >= open.length && !rest.trim()) open = null;
	}
	return open === null ? text : `${text}\n${open}`;
}

/** 行内代码：反引号要比内容里最长的那一串多一个，内容就关不掉它。 */
export function inlineCode(text: string): string {
	const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/\x60+/g), (match) => match[0].length)) + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** 摘要、路径、标题里出现的 `*`、`_` 之类不能变成格式：`grep "a*b"` 不是斜体。 */
function escapeInline(text: string): string {
	return text.replace(/[\\\x60*_[\]<>|~#]/g, "\\$&");
}

function localTime(at: Date): string {
	const two = (value: number) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * 会话标题当文件名。三个平台里 Windows 最严：`<>:"/\|?*` 和控制字符不能用，结尾不能是点或空格，
 * `CON`、`NUL` 这些名字带不带扩展名都是设备。按最严的来，在哪台机器上存都是同一个名字。
 */
export function markdownFileName(title: string, fallback: string): string {
	// 换行、制表先变成空格；剩下的控制字符 Windows 不许有，直接去掉。
	// oxlint-disable-next-line no-control-regex -- 控制字符正是要去掉的那一类。
	let name = title.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"/\\|?*]/g, "_").trim();
	name = name.replace(/[. ]+$/, "");
	// 留够余地给 `.md` 和系统可能加的「(1)」；按码点切，不把一个汉字或表情切成半个。
	name = Array.from(name).slice(0, 120).join("").replace(/[. ]+$/, "");
	if (!name) name = fallback;
	if (RESERVED.test(name)) name = `_${name}`;
	return `${name}.md`;
}
