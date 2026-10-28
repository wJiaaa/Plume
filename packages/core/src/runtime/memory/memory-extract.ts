/**
 * Turning finished sessions into things worth remembering, without being asked each time.
 *
 * `learn` covers the explicit path: something happens, the model writes it down. What it cannot
 * cover is the lesson nobody noticed at the time — a convention that showed up in three sessions,
 * a command that always has to be run first, a mistake made twice. Those only become visible when
 * you read several sessions together, which is not something anybody does.
 *
 * Three things make this safe to run on its own, and they are the design:
 *
 *   It asks first. Extraction sends conversation content to a model, and a tool that runs locally
 *   by default must not start doing that quietly. Off until someone says yes, once.
 *
 *   It never touches `learned.md`. That file holds what a person or the `learn` tool wrote on
 *   purpose. A pass that may rewrite or drop its own entries is only safe because the deliberate
 *   half lives somewhere else.
 *
 * 每次只读上次之后结束的会话，在上一版 `MEMORY.md` 上合并。以前每天从最近 30 天的会话整份重写，
 * 上一版不进输入：来源会话一过 30 天，那条结论就在下次重写时消失；同一个会话被重读近 30 遍；
 * 又看不到 `learned.md` 和项目指令，实测一半条目在复述那两处已有的话。
 *
 *   It takes a lock. Several windows are usually open, and two extractions writing the same file
 *   is how you get half of each.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Message, ModelConfig, ProviderConfig, Usage } from "../../types.ts";
import type { SessionStorage } from "../../session/storage.ts";
import type { streamAssistant } from "../../ai/index.ts";
import { proposeSkill, type SkillCandidate } from "./managed-skills.ts";
import { readReply, replyText } from "../summary/one-shot.ts";
import { projectMemoryDir, readLessons, redactSecrets, sessionMemoryDir } from "./project-memory.ts";
import { loadProjectInstructions } from "../../prompt/system.ts";

/**
 * Sessions younger than this are left alone.
 *
 * A conversation that ended twenty minutes ago is one the person is likely still in the middle of
 * — they closed the window to look something up. Summarising it now reads its unfinished half as
 * if it were a conclusion.
 */
export const MIN_AGE_MS = 12 * 60 * 60 * 1000;
/** Beyond this, what a session concluded is probably no longer true of the code. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** How many sessions one pass will read. */
const MAX_SESSIONS = 40;
/** A lock older than this belonged to a window that is gone. */
export const LOCK_STALE_MS = 10 * 60 * 1000;

export interface ExtractionCandidate {
	id: string;
	updatedAt: number;
	messages: Message[];
}

export interface ExtractionResult {
	/** What was written into `MEMORY.md`, or empty when the pass concluded there was nothing. */
	memory: string;
	/** How many sessions it read. */
	sessions: number;
	/** Set when the pass did not run, with the reason. */
	skipped?: string;
	/** 模型给出了答复（包括「没有要改的」）：这批会话算读过了，游标可以往前走。 */
	answered?: boolean;
	/** 这次提出的技能候选名，进了待确认区。 */
	proposedSkill?: string;
}

/**
 * Whether a session is worth reading.
 *
 * Also excludes the very short ones: a two-message session is a question and an answer, and the
 * lessons this is looking for come from work, not from lookups. `since` 是上次读到哪儿：
 * 那之前就结束、之后没再动过的会话已经合并进上一版了。
 */
export function isCandidate(session: { updatedAt: number; messageCount: number }, now = Date.now(), since = 0): boolean {
	const age = now - session.updatedAt;
	return age >= MIN_AGE_MS && age <= MAX_AGE_MS && session.updatedAt > since && session.messageCount >= 6;
}

/** Take the lock, or report who has it. `null` means somebody else is running. */
export async function acquireLock(dir: string, now = Date.now()): Promise<(() => Promise<void>) | null> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, ".lock");

	const existing = await stat(path).catch(() => null);
	if (existing && now - existing.mtimeMs < LOCK_STALE_MS) return null;
	/*
	 * A stale lock is taken over rather than reported. It means a window closed mid-pass, and the
	 * alternative is memory that stops updating until somebody finds a dotfile and deletes it.
	 */
	await writeFile(path, String(process.pid), "utf8");
	return async () => {
		await rm(path, { force: true }).catch(() => {});
	};
}

/**
 * The prompt that reads sessions and returns lessons.
 *
 * Most of it is about what *not* to return, for the same reason `learn`'s description is: the
 * expensive failure is not an empty file, it is a file of facts that expire. Anything a reader
 * could get by opening the code will be wrong after the next refactor and believed anyway.
 *
 * 「（没有）」的意思是上一版原样保留，不是清空：便宜模型偷懒答一句「没有」，代价只是这次没更新。
 */
export function extractionPrompt(): string {
	return [
		"你在维护一个项目的「推断记忆」：从过去的会话里总结出的、**下次还用得上**的东西。",
		"",
		"输入有四部分：",
		"- 当前指令（项目指令和用户的全局指令）、刻意记下的条目：这些每轮都会原样给模型看",
		"- 上一版推断记忆：你要更新的对象，可能被人手改过",
		"- 新会话：上次更新之后才结束的会话",
		"",
		"产出更新后的**完整**推断记忆：",
		"- 上一版里仍然成立的条目保留，不要因为新会话没提到就删掉",
		"- 新会话里值得记的加进去；和已有条目说同一件事的合成一条",
		"- 新会话明确推翻了的条目改掉或删掉",
		"- 当前指令或刻意记下的条目里已经说过的不要写；上一版里与它们重复的删掉",
		"",
		"值得记的：",
		"- 这个仓库的约定，尤其是从代码里看不出来的（构建命令、部署流程、为什么某处要那么写）",
		"- 用户纠正过的做法，而且这个纠正会反复适用",
		"- 踩过并解决了的坑，下次还会踩的那种",
		"- 反复出现的工作流（「改完 X 之后总要跑 Y」）",
		"",
		"**不要记：**",
		"- 代码结构、文件位置、函数签名——读代码就知道，而且会过期",
		"- 某一次任务的具体内容",
		"- git 历史里已经有的信息",
		"- 你不确定是不是普遍成立的东西",
		"",
		"记忆库里一条过时的事实比没有这条更糟，因为模型会照着它做决定。宁可少写。",
		"",
		"输出 markdown 列表，每条一行，一两句话，具体可执行，只输出列表本身。",
		"上一版不需要任何改动（没有要加的，也没有要改或删的）时，只输出「（没有）」。",
	].join("\n");
}

/**
 * 除了记忆条目，还问一句：这里面有没有一段值得做成技能的流程。
 *
 * 一条记忆是「记住这件事」，一个技能是「下次照着做」。「改完 core 之后要跑 `pnpm arch` 和
 * `pnpm typecheck`」写成记忆，模型每轮读到它、然后自己决定要不要照做；写成技能，它在需要
 * 的时候被整段调出来。
 *
 * 分成两次请求而不是一次问两件事：一次请求要两种格式的输出，模型会把两者混在一起，而解析
 * 失败的那一半是静默丢掉的。两次都是便宜模型上的小请求。
 */
function skillProposalPrompt(): string {
	return [
		"你在读一个项目最近的几次会话记录，找**一段反复出现、下次可以照着做的流程**。",
		"",
		"算的：",
		"- 「改完 X 之后总要跑 Y 和 Z」这种检查清单",
		"- 一件事的固定做法，步骤明确、换个人也能照做",
		"",
		"**不算的：**",
		"- 只出现过一次的事",
		"- 一句约定（那是记忆，不是技能）——「用 pnpm 不用 npm」不该做成技能",
		"- 需要判断力才能执行的事（「审查代码质量」）",
		"- 某次发布的版本号、目录快照、包数量、临时分支名；这些不是可复用流程",
		"",
		"复用质量要求：",
		"- 至少两个不同来源会话反复支持同一个流程；只见过一次或证据不足就输出（没有）。",
		"- 优先提炼 portable 流程：把项目名、版本号、分支、路径作为输入；保留具体的发现方法、步骤和验证。",
		"- 只有项目独有约定才选 project，并在名字、描述和适用范围中明确限制，不能伪装成通用技能。",
		"- 正文依次使用：## 适用范围、## 输入与前置检查、## 执行步骤、## 验证与失败处理。",
		"- 执行前读取当前项目指令、manifest、workspace 配置和脚本以发现真实文件、数量、分支及命令；引用配置来源，不能把历史快照写成固定事实。",
		"- 输入包含当前项目指令。它用于校正旧会话中已经过时的流程；新技能必须明确要求每次执行重新读取 AGENTS.md / PLUME.md 等当前指令。",
		"- 优先调用仓库已有的版本同步、检查、发布脚本；不能把旧会话里手动改 6 个 package.json 的操作固化下来。",
		"- 仓库有统一发布脚本时，不另写 git add -A、commit、tag、push 的手工旁路；只有当前指令明确允许手动流程才展开它。不假定 monorepo 的所有子包必须同版本。",
		"- 保留强制门禁的强制性，不得把必须的发布预演降为推荐；明确触发条件、不适用条件及验证失败时停止的规则。",
		"- 合并、发布、删除等操作仍以当前用户授权和项目指令为准，历史会话中的授权不能延续到未来任务。",
		"- 失败时保留现场、说明原因并停止；不得自动回滚、覆盖用户已有修改，也不能为完成步骤而弱化门禁。",
		"- 输出前自查：换一个目录结构和目标版本是否仍能按输入发现正确目标？否则重写或放弃。不要为了通用性删掉可执行细节。",
		"",
		"**宁可什么都不给。** 一个自动生成的技能会改变这个 agent 以后的行为，而看到它的人多半",
		"不记得自己批准过什么。只有在你能写出具体步骤时才给。",
		"",
		"有的话按这个格式输出，只输出这些字段加正文：",
		"NAME: <小写连字符的名字，三四个词>",
		"DESCRIPTION: <一句话，说清什么时候该用它>",
		"SCOPE: <portable 或 project>",
		"SOURCES: <支持此流程的至少两个会话 ID，以逗号分隔，必须来自输入>",
		"BODY:",
		"<正文，步骤列表>",
		"",
		"没有就只输出「（没有）」。",
	].join("\n");
}

/**
 * 读模型的技能提案。
 *
 * 任何一处不完整都返回 null：一个缺了步骤的技能会以一个人不知道的方式改变 agent 的行为，
 * 而「少一个候选」这件事没有任何代价。
 */
export function parseSkillProposal(text: string, sourceIds: readonly string[]): SkillCandidate | null {
	if (text.includes("（没有）") || text.includes("(没有)")) return null;
	const name = /^NAME:\s*(.+)$/m.exec(text)?.[1]?.trim().toLowerCase();
	const description = /^DESCRIPTION:\s*(.+)$/m.exec(text)?.[1]?.trim();
	const body = text.split(/^BODY:\s*$/m)[1]?.trim();
	if (!name || !description || !body) return null;
	if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) return null;
	const scope = /^SCOPE:\s*(.+)$/m.exec(text)?.[1]?.trim();
	const sources = [...new Set((/^SOURCES:\s*(.+)$/m.exec(text)?.[1] ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
	if (scope !== "portable" && scope !== "project") return null;
	if (sources.length < 2 || sources.some((id) => !sourceIds.includes(id))) return null;
	if (!["适用范围", "输入与前置检查", "执行步骤", "验证与失败处理"].every((heading) => body.includes(`## ${heading}`))) return null;
	return { name, description, body, scope, sourceSessions: sources };
}

/** Render sessions compactly enough that several fit in one request. */
export function renderSessions(candidates: ExtractionCandidate[]): string {
	const blocks: string[] = [];
	for (const session of candidates) {
		const lines: string[] = [`## 会话 ${session.id}`];
		for (const message of session.messages) {
			if (message.role === "user" && !message.synthetic) {
				lines.push(`用户：${textOf(message).slice(0, 600)}`);
			} else if (message.role === "assistant") {
				const said = textOf(message).trim();
				if (said) lines.push(`助手：${said.slice(0, 600)}`);
			}
			/*
			 * Tool results are left out entirely. They are the bulk of a transcript and the least
			 * of what it means — file contents and command output describe the state of the code at
			 * one moment, which is exactly the kind of thing that must not become a memory.
			 */
		}
		blocks.push(lines.join("\n"));
	}
	/*
	 * 发给模型之前先脱敏——这是两道里更要紧的一道。
	 *
	 * 写盘前再脱一次是兜底；而模型根本没见过的密钥，它回显不出来，也编不进技能提案里。
	 * 一个人在会话里贴过 `sk-proj-…` 排查问题，那串东西不该以任何形式离开那次会话。
	 */
	return redactSecrets(blocks.join("\n\n"));
}

/** Historical commands need today's project rules before they can become tomorrow's workflow. */
async function skillProposalInput(cwd: string, candidates: ExtractionCandidate[]): Promise<string> {
	const instructions = await loadProjectInstructions(cwd);
	const current = instructions.map((file) => `### ${relative(cwd, file.path)}\n${file.content}`).join("\n\n");
	return redactSecrets(`## 当前项目指令\n${current || "未找到项目指令文件。技能执行时仍须重新发现当前配置，不能假定历史命令仍然适用。"}\n\n## 历史会话证据\n${renderSessions(candidates)}`);
}

/**
 * 合并时要看的全部东西。
 *
 * 当前指令和 `learned.md` 放进来是为了**不**复述它们：那两处每轮都原样进提示词，`MEMORY.md`
 * 再说一遍只是多花一份 token，还更早撞上注入预算。
 */
async function extractionInput(options: ExtractOptions): Promise<string> {
	const [instructions, lessons, previous] = await Promise.all([
		loadProjectInstructions(options.cwd).catch(() => []),
		readLessons(options.cwd).catch(() => []),
		readExtractedMemory(options.cwd),
	]);
	const current = [
		...instructions.map((file) => `### ${relative(options.cwd, file.path)}\n${file.content}`),
		...(options.globalInstructions?.trim() ? [`### 用户的全局指令\n${options.globalInstructions.trim()}`] : []),
	].join("\n\n");
	return redactSecrets([
		`## 当前指令\n${current || "（没有）"}`,
		`## 刻意记下的条目\n${lessons.map((lesson) => `- ${lesson.text}`).join("\n") || "（没有）"}`,
		`## 上一版推断记忆\n${previous || "（还没有）"}`,
		`## 新会话\n${renderSessions(options.candidates)}`,
	].join("\n\n"));
}

function textOf(message: Message): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export interface ExtractOptions {
	cwd: string;
	candidates: ExtractionCandidate[];
	provider: ProviderConfig;
	model: ModelConfig;
	stream: typeof streamAssistant;
	signal?: AbortSignal;
	/** Where the reply's bill goes. The pass belongs to no session, so no transcript counts it. */
	spent?: (usage: Usage) => Promise<void>;
	/** 设置里的全局自定义指令：它每轮都在提示词里，合并时据此不复述。 */
	globalInstructions?: string;
}

/**
 * Read the sessions, write `MEMORY.md`, leave `learned.md` alone.
 *
 * Returns what it wrote so the caller can show it. Nothing here enables anything: the consent
 * check and the scheduling belong to whoever calls this, because they are the parts that differ
 * between a desktop window and a headless run.
 */
export async function extractMemory(options: ExtractOptions): Promise<ExtractionResult> {
	if (options.candidates.length === 0) return { memory: "", sessions: 0, skipped: "没有符合条件的会话" };

	const dir = projectMemoryDir(options.cwd);
	const release = await acquireLock(dir);
	if (!release) return { memory: "", sessions: 0, skipped: "另一个窗口正在抽取" };

	try {
		const stream = options.stream(
			options.provider,
			options.model,
			{
				systemPrompt: extractionPrompt(),
				messages: [
					{ role: "user", content: [{ type: "text", text: await extractionInput(options) }], timestamp: Date.now() },
				],
				tools: [],
			},
			{ signal: options.signal, thinking: "off" },
		);

		/*
		 * A failed request is a pass that did not happen, not an error to surface.
		 *
		 * This runs on its own, without anybody waiting for it. A provider being unreachable means
		 * the memory is not updated this time, which is invisible and correct; raising it would put
		 * an error in front of someone who did not ask for anything.
		 */
		const read = await readReply(stream);
		if ("error" in read) return { memory: "", sessions: options.candidates.length, skipped: "抽取时模型没能返回" };
		const { reply } = read;
		// Billed whatever the reply turns out to be — an interrupted or empty answer was still paid for.
		await options.spent?.(reply.usage);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			return { memory: "", sessions: options.candidates.length, skipped: "抽取被中断" };
		}
		/*
		 * 要的是「更新后的完整记忆」，整份覆盖 MEMORY.md。撞上输出上限的那份只有前半截，写下去就把截断处
		 * 之后的旧条目永久删了；不算读过（没有 `answered`），游标不走，这批会话下次再读。
		 */
		if (reply.stopReason !== "stop") {
			return { memory: "", sessions: options.candidates.length, skipped: "抽取的回复不完整，这次没有写入" };
		}

		const text = replyText(reply, "\n").trim();

		/*
		 * "（没有）" is a real answer and must not be written as if it were a lesson. A model told to
		 * find something will find something; leaving it a way to say no is what keeps the file from
		 * filling with restatements of the obvious. 它现在的意思是「上一版不用改」，文件原样留着。
		 */
		if (!text || /^（?没有）?$/.test(text)) {
			const proposedSkill = await proposeFromSessions(options).catch(() => null);
			return { memory: "", sessions: options.candidates.length, skipped: "这些会话里没有值得记的", answered: true, ...(proposedSkill ? { proposedSkill } : {}) };
		}

		/*
		 * 写盘前再脱一次。输入侧已经脱过，这里防的是另一种事：模型凭形状重构出一个像密钥的串，
		 * 或者输入侧的正则漏了某种新格式。记忆会每轮注入提示词，一次漏网就是永久泄漏。
		 */
		const clean = redactSecrets(text);

		const body = [
			"# 从会话里总结的",
			"",
			`由后台抽取生成，每次在这一版上合并新结束的会话（上次读了 ${options.candidates.length} 次）。可以手改，下次合并照着改过的继续——`,
			"要保留的内容请移到 `learned.md`：这里的条目合并时可能被改写或删掉，那个文件抽取永远不碰。",
			"",
			clean,
			"",
		].join("\n");

		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "MEMORY.md"), body, "utf8");

		/*
		 * 再问一次：这里面有没有一段值得做成技能的流程。
		 *
		 * 第二次请求而不是一次问两件事——一次要两种格式的输出，模型会把它们混在一起，而解析
		 * 失败的那一半是静默丢掉的。两次都是便宜模型上的小请求。
		 *
		 * 失败当没有：这一步是锦上添花，而记忆已经写下来了。让它把整次抽取拖失败，是拿一个
		 * 可有可无的东西去赌一个有用的东西。
		 */
		// What it proposes goes to `.pending`, not into use: see `managed-skills.ts`.
		const proposedSkill = await proposeFromSessions(options).catch(() => null);
		return { memory: clean, sessions: options.candidates.length, answered: true, ...(proposedSkill ? { proposedSkill } : {}) };
	} finally {
		await release();
	}
}

/**
 * 问一次「有没有值得做成技能的流程」，有就写进待确认区。
 *
 * 返回技能名，或者 null——而 null 是常态：绝大多数会话里没有那样的东西，而提示词里特意写了
 * 「宁可什么都不给」。一个被逼着找出来的流程，就是那种会被批准一次然后困扰一年的东西。
 */
async function proposeFromSessions(options: ExtractOptions): Promise<string | null> {
	// A single session cannot establish that a workflow recurs, regardless of the model's answer.
	const sourceIds = [...new Set(options.candidates.map((candidate) => candidate.id))];
	if (sourceIds.length < 2) return null;
	const input = await skillProposalInput(options.cwd, options.candidates);
	const stream = options.stream(
		options.provider,
		options.model,
		{
			systemPrompt: skillProposalPrompt(),
			messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
			tools: [],
		},
		{ signal: options.signal, thinking: "off" },
	);

	const read = await readReply(stream);
	if ("error" in read) return null;
	const { reply } = read;
	if (reply.stopReason === "error" || reply.stopReason === "aborted") return null;

	const text = replyText(reply, "\n");

	const proposal = parseSkillProposal(text, sourceIds);
	if (!proposal) return null;
	const written = await proposeSkill(options.cwd, proposal);
	return written ? proposal.name : null;
}

/** What was extracted last time, for injection alongside `learned.md`. */
export async function readExtractedMemory(cwd: string): Promise<string> {
	const raw = await readFile(join(projectMemoryDir(cwd), "MEMORY.md"), "utf8").catch(() => null);
	if (raw === null) return "";
	/*
	 * The header explains the file to a person opening it and means nothing to the model, so it is
	 * dropped rather than spent on every prompt in this project.
	 */
	const body = raw.split("\n").filter((line) => !line.startsWith("#") && !line.startsWith("由后台抽取") && !line.startsWith("要保留的内容"));
	return body.join("\n").trim();
}

/**
 * This project's sessions that are worth a pass, newest first.
 *
 * Matched by memory directory rather than `projectId`: a session run in its own worktree has the
 * worktree's id, and its transcripts belong to the project it branched from (`sessionMemoryDir`).
 */
export async function findCandidates(
	storage: Pick<SessionStorage, "listSessions" | "messages">,
	cwd: string,
	now = Date.now(),
	since = 0,
): Promise<ExtractionCandidate[]> {
	const found: ExtractionCandidate[] = [];
	const dir = projectMemoryDir(cwd);
	// The list is newest first, so the first MAX_SESSIONS candidates are the ones kept; reading past them loads transcripts only to drop them.
	for (const meta of await storage.listSessions()) {
		if (found.length >= MAX_SESSIONS) break;
		// Age first: it is free, and the directory walks `.git` pointers on disk.
		if (!isCandidate(meta, now, since) || sessionMemoryDir(meta) !== dir) continue;
		const messages = await storage.messages(meta.id).catch(() => []);
		found.push({ id: meta.id, updatedAt: meta.updatedAt, messages });
	}
	return found;
}
