/**
 * 一次工具调用、一段工具调用，用人话怎么说。
 *
 * 从 `conversation/ToolGroup.tsx` 搬来：对话里那一行「读取文件 3 个」、子智能体输入框上方那条和
 * 面板顶上的「此刻在做什么」，说的是同一件事，应该是同一种说法。子智能体那几处从前直接摆 core 给的
 * 英文摘要（`Read README.md`、`Search "signIn"`），和旁边转录里的「读取文件 README.md」对不上。
 */

import { formatList } from "../i18n/list.ts";
import { translate } from "../i18n/translate.ts";
import type { MessageKey } from "../i18n/messages/index.ts";
import { baseName } from "./paths.ts";
import { isShellRead } from "./shell-reads.ts";

/**
 * What a run of calls did, in the words someone would use to describe it afterwards.
 *
 * Grouped by the kind of action rather than by tool name, because "读取" is what three different
 * tools amount to from the outside. One action of one kind names its subject — that is the case
 * where the detail fits and is worth having; anything more is counted.
 */
export function describeRun(calls: { toolName: string; subject?: string }[]): string {
	const buckets = new Map<string, string[]>();
	for (const call of calls) {
		const kind = KIND[call.toolName] ? translate(KIND[call.toolName]) : translate("tools.using");
		const list = buckets.get(kind) ?? [];
		if (call.subject) list.push(call.subject);
		buckets.set(kind, list);
	}

	const counts = new Map<string, number>();
	const times = new Set<string>();
	for (const call of calls) {
		const kind = KIND[call.toolName] ? translate(KIND[call.toolName]) : translate("tools.using");
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
		if (TIMES.has(KIND[call.toolName])) times.add(kind);
	}

	const parts: string[] = [];
	for (const [kind, count] of counts) {
		const subjects = buckets.get(kind) ?? [];
		// One of a kind, with a name worth saying: say it.
		if (count === 1 && subjects.length === 1) parts.push(`${kind} ${subjects[0]}`);
		// One of a kind with nothing to name — "执行命令 1 个" counts to one, which is just noise.
		else if (count === 1) parts.push(kind);
		// 网页上的点击、输入是「次」不是「个」：「操作网页 4 个」读着像四张网页。
		else parts.push(translate(times.has(kind) ? "tools.countTimes" : "tools.countOf", { kind, count }));
	}
	return formatList(parts);
}

/*
 * 工具名到「它在做什么」的那个说法，存 key。
 *
 * 这张表在模块加载时成型，那会儿窗口还没说自己是哪种语言。译发生在读它的地方。
 */
const KIND: Record<string, MessageKey> = {
	write: "tools.create",
	edit: "tools.edit",
	read: "tools.read",
	bash: "tools.bash",
	bash_output: "tools.output",
	monitor: "tools.monitor",
	glob: "tools.find",
	grep: "tools.grep",
	ls: "tools.ls",
	todo_write: "tools.todo",
	web_fetch: "tools.fetch",
	web_search: "tools.webSearch",
	task: "tools.delegate",
	stop_subagent: "tools.stopSubAgent",
	preview: "tools.preview",
	image_generate: "tools.generateImage",
	symbol: "tools.symbol",
	/*
	 * 技能、学习、回忆、语言服务、问一句——这五个从前不在表里，一律落到「使用 …」。
	 *
	 * 于是一行摘要读作「使用 3 个」，而那三个各是各的事。表里缺一项的代价不是报错，是那一行悄悄
	 * 变成一句废话——`describeRun` 的兜底本来就是给真正没见过的工具准备的，不是给自家工具的。
	 */
	skill: "tools.skill",
	submit_plan: "tools.submitPlan",
	learn: "tools.learn",
	recall: "tools.recall",
	lsp: "tools.lsp",
	ask_user: "tools.askUser",
	// 侧边聊天翻主对话用的那一个——它的工具组从前一律读作「使用工具 3 个」。
	read_main_chat: "tools.readMainChat",
	// The desktop's session-level tools (`electron/session/session-ops.ts`): the card says the rest, the row says what happened.
	spawn_session: "tools.spawnSession",
	archive_session: "tools.archiveSession",
	review_session: "tools.reviewSession",
	/*
	 * 内置浏览器那几个（`electron/browser/browser-tools.ts`）。它们没有 `summarize`，core 给的摘要就是工具名本身，
	 * 不在表里时一行读作「browser_act」。
	 */
	browser_open: "tools.browserOpen",
	browser_act: "tools.browserAct",
	browser_tabs: "tools.browserTabs",
	browser_viewport: "tools.browserViewport",
	browser_screenshot: "tools.browserScreenshot",
	// 会话之间那五个（`electron/peer/peer-tools.ts`），见 `PEER_TOOLS`。
	list_sessions: "tools.listSessions",
	ask_session: "tools.askSession",
	reply_session: "tools.replySession",
	notify_session: "tools.notifySession",
	wait_for_session: "tools.waitForSession",
	// 模型给这个对话安排的定时唤醒（core 的 `wakeup-tools.ts`），见环境卡片「定时唤醒」那一节。
	schedule_wakeup: "tools.scheduleWakeup",
	cron_create: "tools.cronCreate",
	cron_list: "tools.cronList",
	cron_delete: "tools.cronDelete",
};

/**
 * 会话之间那五个工具。它们的 `summarize` 是写给模型日志的英文（`Notify 名字 [ref]`），重开的会话里又只剩
 * 工具名，两条路都不是人话，所以一律照 `KIND` 说，对象是参数里的 `to`（`call-words.ts` 的 `subjectOf`）。
 */
export const PEER_TOOLS = new Set(["list_sessions", "ask_session", "reply_session", "notify_session", "wait_for_session"]);

/** 按「次」数、不按「个」数的那几种。 */
const TIMES = new Set<MessageKey>(["tools.browserAct"]);

/**
 * core 给的那句英文摘要（`Read src/a.ts`、`Search "x"`、`List .`），换成和转录里同一种说法。
 *
 * 那句话是每个工具的 `summarize` 写的，只有这几种固定的开头；认不出来的（命令的描述、网页的标题）
 * 原样留着——它们本来就是人写的话。
 */
const ACTIVITY: [RegExp, string, (match: RegExpMatchArray) => string][] = [
	// core 的 `submit_plan` 的 summarize。
	[/^Plan: ?(.*)$/, "submit_plan", (m) => m[1]],
	[/^Suggest session ?(.*)$/, "spawn_session", (m) => m[1]],
	[/^Archive session$/, "archive_session", () => ""],
	[/^Review session ?(.*)$/, "review_session", (m) => m[1]],
	[/^Schedule wakeup ?(.*)$/, "schedule_wakeup", (m) => m[1]],
	[/^Create cron ?(.*)$/, "cron_create", (m) => m[1]],
	[/^List cron jobs$/, "cron_list", () => ""],
	[/^Delete cron ?(.*)$/, "cron_delete", (m) => m[1]],
	[/^Read (.+)$/, "read", (m) => baseName(m[1])],
	[/^Write (.+)$/, "write", (m) => baseName(m[1])],
	[/^Edit (.+)$/, "edit", (m) => baseName(m[1])],
	[/^List (.+)$/, "ls", (m) => m[1]],
	[/^Find definition of (.+)$/, "symbol", (m) => m[1]],
	[/^Find (.+)$/, "glob", (m) => m[1]],
	[/^Search "(.+)"$/, "grep", (m) => m[1]],
	[/^Fetch (.+)$/, "web_fetch", (m) => m[1]],
	[/^Generate image (.+)$/, "image_generate", (m) => m[1]],
];

/** `bash_output` 的两句摘要和 `stop_subagent` 那一句：不带 id，一串 uuid 人读不出东西。 */
const FIXED: Record<string, MessageKey> = {
	"Check job": "tools.output",
	"Stop job": "tools.stopJob",
	"Stop sub-agent": "tools.stopSubAgent",
};

/**
 * 一次调用在行上怎么说。
 *
 * 自己没写 `summarize` 的工具，core 交回来的摘要就是工具名（`tool-run.ts`）；表里认得它，就照一段活的
 * 说法讲，连同参数里那个值得点名的东西（「打开网页 todo.html」）。其余交给 `describeActivity`。
 */
export function describeCall(toolName: string, summary: string | undefined, subject?: string): string {
	if ((summary === undefined || summary === toolName || PEER_TOOLS.has(toolName)) && KIND[toolName]) return describeRun([{ toolName, subject }]);
	return describeActivity(summary ?? toolName);
}

/**
 * 一段活按什么归类：同一类连着做的调用，在转录里合成一行（见 `grouping.ts` 的 `Step`）。
 *
 * 分的是「从外面看在干同一件事」：读、搜、列目录都是在看代码；写和改都是在动文件；浏览器那几个都是
 * 在用同一个页面。表里没有的工具自成一类，连着调同一个工具才合在一起。
 *
 * `bash` 看命令本身：`rg`、`sed -n`、`git log` 和 read、grep 是同一件事，归探索（`isShellRead`）。
 * 命令还在流进来时按已经到了的那部分判，所以一条 `rg x > out` 会在 `>` 到的那一刻从探索换到终端——
 * 只有这一次，而且就在它自己生成的那一两百毫秒里。
 */
export function toolCategory(toolName: string, args?: unknown): string {
	if (toolName.startsWith("browser_")) return "browser";
	if (toolName === "bash") {
		const command = (args as { command?: unknown } | undefined)?.command;
		return typeof command === "string" && isShellRead(command) ? "explore" : "terminal";
	}
	return CATEGORY[toolName] ?? toolName;
}

const CATEGORY: Record<string, string> = {
	write: "files",
	edit: "files",
	read: "explore",
	ls: "explore",
	glob: "explore",
	grep: "explore",
	symbol: "explore",
	lsp: "explore",
	bash_output: "terminal",
	monitor: "terminal",
	web_fetch: "web",
	web_search: "web",
};

export function describeActivity(summary: string): string {
	const fixed = FIXED[summary];
	if (fixed) return translate(fixed);
	for (const [pattern, toolName, subject] of ACTIVITY) {
		const match = summary.match(pattern);
		if (match) return describeRun([{ toolName, subject: subject(match) }]);
	}
	return summary;
}
