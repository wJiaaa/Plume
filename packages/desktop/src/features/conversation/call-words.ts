/**
 * 一次调用、一段调用在行上用的那几个词和数，纯数据。
 *
 * 从 `runs.tsx` 拆出来：`WorkStep` 要用它们，而 `runs.tsx` 经文件预览连回转录，从 `WorkStep` 引它就是
 * 一条新的循环依赖。
 */

import type { AssistantContent } from "@plume/core";
import type { ToolRun as ToolRunState } from "../../store/index.ts";
import { baseName, relativeTo, tildeHome } from "../../lib/paths.ts";
import { translate } from "../../i18n/translate.ts";
import { describeCall, describeRun, PEER_TOOLS } from "../../lib/tool-kinds.ts";
import type { Call } from "./grouping.ts";
import type { StepMember } from "./turn-blocks.ts";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

/**
 * What a set of calls did, in words — the same sentence a run line and a turn line use.
 *
 * 查输出是那条后台命令的一部分：这一段里有命令时不另记；只有查看时，一个任务记一次。从前按调用数，
 * 一条命令被查了九次，这一行就说「执行命令 1 个、查看输出 9 个」。
 */
export function describeCalls(calls: Call[]): string {
  return describeRun(counted(calls).map(({ block }) => ({ toolName: block.name, subject: subjectOf(block) })));
}

function counted(calls: Call[]): Call[] {
  const commands = calls.some(({ block }) => block.name === "bash" || block.name === "monitor");
  const jobs = new Set<unknown>();
  return calls.filter(({ block }) => {
    if (block.name !== "bash_output") return true;
    const job = (block.arguments as { id?: unknown } | undefined)?.id;
    if (commands || jobs.has(job)) return false;
    jobs.add(job);
    return true;
  });
}

/**
 * core 给 grep、glob 留着一句给人看的 `description`：它们的参数是正则和通配，人读不出来。
 *
 * bash 的那句 core 也会经 `summarize` 放进 `summary`，但要到 `tool_start` 才有：工具等整条回复写完才
 * 执行，一条命令后面跟着一个长 `write` 时，它写完了要排十几秒，那段时间没有记录，行上只剩「执行命令」。
 * 直接读参数，说明一写出来就是标题，和开跑后 core 给的是同一句。
 *
 * read 和 ls 不在这里，说的是 `locationOf`：让模型每次读文件都写一句，写出来的是「读取第三上游响应归一化」
 * 「读取第三上游请求分发」——同一个句式套七遍，中间是它自己起的代号。Claude Code、pi 的 read 也都不收说明。
 */
const DESCRIBED = new Set(["grep", "glob", "bash", "monitor"]);

/**
 * 读文件、列目录那一行说的对象：相对工作区的完整路径，照 pi 的写法。
 *
 * 只说文件名时，`apps/web/src/main.tsx` 和 `apps/cli/src/main.ts` 读起来是同一个 main。只读了一段的带上
 * 行号，同一个文件读两段才分得开；目录带 `/`，和文件一眼分开。工作区外的路径照原样，家目录缩成 `~`。
 */
function locationOf(block: ToolCallBlock, root?: string): string | undefined {
  const { path, offset, limit } = (block.arguments ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
  const shown = (value: string) => tildeHome(root ? relativeTo(root, value) : value);
  if (block.name === "ls") {
    const dir = shown(typeof path === "string" && path !== "" ? path : ".");
    return /[\\/]$/.test(dir) ? dir : `${dir}/`;
  }
  if (block.name !== "read" || typeof path !== "string" || path === "") return undefined;
  return `${shown(path)}${lineRange(offset, limit)}`;
}

/** `:10-29`；只给了起点是 `:10-`，只给了行数从第 1 行算。模型常把没给的参数写成 null，所以按类型认。 */
function lineRange(offset: unknown, limit: unknown): string {
  const from = typeof offset === "number" ? offset : undefined;
  const count = typeof limit === "number" ? limit : undefined;
  if (from === undefined && count === undefined) return "";
  const start = from ?? 1;
  return `:${start}-${count === undefined ? "" : start + count - 1}`;
}

/** 一次 `bash_output` 查的是哪个后台任务。停掉它的那一次不是在看输出，不和查看合在一起。 */
export function polledJob(block: ToolCallBlock): string | undefined {
  if (block.name !== "bash_output") return undefined;
  const { id, kill } = (block.arguments ?? {}) as { id?: unknown; kill?: unknown };
  return typeof id === "string" && kill !== true ? id : undefined;
}

/** 启动这个后台任务的那次 `bash` 或 `monitor`：它的 `summary` 是模型给那条命令写的说明。 */
export function startedJob(runs: Record<string, ToolRunState>, job: string): ToolRunState | undefined {
  for (const run of Object.values(runs)) {
    const details = run.result?.details as { kind?: unknown; id?: unknown } | undefined;
    if ((details?.kind === "bash_background" || details?.kind === "monitor") && details.id === job) return run;
  }
  return undefined;
}

/** 查看后台任务输出那一行：说是哪个任务，连着查了几次也说。找不到启动它的那次调用，就只说「查看输出」。 */
export function describePolls(what: string | undefined, times: number): string {
  if (what) return times > 1 ? translate("tools.outputOfTimes", { what, n: times }) : translate("tools.outputOf", { what });
  return times > 1 ? translate("tools.outputTimes", { n: times }) : translate("tools.output");
}

/** 转录里挂在竖线上的一行：一次调用、一段推理，或者连着查同一个后台任务的几次输出。 */
export type StepLine = StepMember | { kind: "polls"; calls: Call[] };

/**
 * 连着查同一个后台任务的几次合成一行。
 *
 * 只合紧挨着的：中间隔了推理、别的调用，就是模型在两次查看之间做了别的事，那是两件事。
 */
export function foldPolls(members: StepMember[]): StepLine[] {
  const lines: StepLine[] = [];
  for (const member of members) {
    const job = member.kind === "call" ? polledJob(member.call.block) : undefined;
    const last = lines[lines.length - 1];
    const before = last?.kind === "polls" ? last.calls : last?.kind === "call" ? [last.call] : [];
    if (job && member.kind === "call" && before.length > 0 && polledJob(before[0].block) === job) {
      lines[lines.length - 1] = { kind: "polls", calls: [...before, member.call] };
    } else {
      lines.push(member);
    }
  }
  return lines;
}

/**
 * 几次查看读到的输出，接成一段。
 *
 * 每一次 `bash_output` 只给上次之后新打出来的，所以按顺序接起来就是这段时间里的全部，不重复。去掉的
 * 是给模型看的那两样：开头那行带任务 id 的状态（`[job … running]`），和没有新输出时的那句占位。
 */
export function pollOutput(runs: (ToolRunState | undefined)[]): string {
  return runs
    .map((run) => (run?.result?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"))
    .map((text) => text.replace(/^\[job [^\]\n]*\]\n?/, "").replace(/^\(no new output\)/, ""))
    .join("");
}

/**
 * 一次调用在行上怎么说：读文件、列目录说路径（`root` 是工作区，见 `locationOf`）；模型写了一句给人看的
 * 说明就用它，没写就退回 core 的摘要。查后台任务输出的那一次说是哪个任务（`job`：启动它的那条命令的说明）。
 */
export function describeOne(block: ToolCallBlock, summary?: string, context: { job?: string; root?: string } = {}): string {
  if (polledJob(block)) return describePolls(context.job, 1);
  if (block.name === "todo_write") return describeTodos(block.arguments);
  const location = locationOf(block, context.root);
  if (location) return describeRun([{ toolName: block.name, subject: location }]);
  const { description } = (block.arguments ?? {}) as { description?: unknown };
  const said = typeof description === "string" ? description.trim() : "";
  if (said && DESCRIBED.has(block.name)) return said;
  return describeCall(block.name, summary, subjectOf(block));
}

/**
 * 更新清单那一行：进度，加上接下来在做的那一项。
 *
 * core 的摘要只在有进行中的一项时说它，否则是一句写给日志的「Update task list」；重开的会话里摘要又是
 * `summarizeToolCall` 的固定句。两条路都从参数里取，直播和重开说的是同一句。参数还在流进来时清单不全，
 * 退回只说「更新清单」。
 */
function describeTodos(args: unknown): string {
  const todos = (args as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return translate("tools.todo");
  const items = todos.filter((t): t is { content?: unknown; status?: unknown } => !!t && typeof t === "object");
  const done = items.filter((t) => t.status === "completed").length;
  const task = items.find((t) => t.status === "in_progress")?.content;
  const progress = { done, total: todos.length };
  return typeof task === "string" && task.trim() ? translate("tools.todoAt", { ...progress, task: task.trim() }) : translate("tools.todoOf", progress);
}

/** The file a call is about, when it is about one — the part worth naming in a summary. */
function subjectOf(block: ToolCallBlock): string | undefined {
  const { path, url, to } = (block.arguments ?? {}) as { path?: unknown; url?: unknown; to?: unknown };
  // Either separator: a Windows path split on "/" alone came back whole, drive letter and all.
  if (typeof path === "string") return baseName(path);
  // 只认会话之间那几个：MCP 工具也常有 `to`（收件人），单独一次调用时会被说成「使用工具 alice@…」。
  if (PEER_TOOLS.has(block.name)) return typeof to === "string" && to.trim() ? peerName(to.trim()) : undefined;
  // 打开的网页：本地文件报文件名，网站报主机名——整串地址放在一行摘要里只会被截掉。
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const name = baseName(parsed.pathname);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? (/\.html?$/i.test(name) ? name : parsed.host) : name || undefined;
  } catch {
    return baseName(url) || undefined;
  }
}

/** 地址里的名字：`修登录 [a1b2c3]` 画成「修登录」，ref 是给模型认人的；只写了 ref 的照原样。 */
export function peerName(address: string): string {
  return address.replace(/\s*\[[0-9a-f]{6,12}\]$/i, "") || address;
}

export function diffOf(run: ToolRunState | undefined, key: "added" | "removed"): number {
  const value = (run?.result?.details as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" ? value : 0;
}
