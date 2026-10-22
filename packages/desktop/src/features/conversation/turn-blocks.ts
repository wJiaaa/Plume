/**
 * 转录按回合分块：开口那句话之后到下一句之前算一轮，有过程的一轮里同一类连着做的调用合成一步。
 *
 * 和 `grouping.ts` 是两层：那边把消息切成 Run（一句话、一段工具），这里把 Run 按回合收起来。
 * `Conversation` 两层都用，子智能体面板只用那一层。
 */

import type { DeliveredReport } from "@plume/core";
import { toolCategory } from "../../lib/tool-kinds.ts";
import { runKey, type Call, type Run } from "./grouping.ts";
import { samePage } from "./preview-pages.ts";
import { opensTurn, sameStats, settled } from "./turns.ts";

/**
 * 一轮：开口的那句话之后，到下一句之前的全部。
 *
 * 读下来是「想 → 做 → 说」。有过程的一轮整块交给 `TurnWork` 一行行摊开：同一类连着做的调用合成一行
 * （`Step`），中途说的话、最后的回答各占一行，顺序就是发生的顺序。不再有整轮的锚和整轮折叠，为什么见
 * `TurnWork`。
 *
 * 在 Run 这一层分，不在渲染时分：这是一条关于转录形状的规则，规则性的东西要能单独测。
 */
export interface TurnBlock {
	/** `work`：有过程的一轮，按 `items` 一行行画。`plain`：一行原样画的东西——开口的那句话，或者没有过程的一轮里的每一行。 */
	kind: "work" | "plain";
	/** 跑着的一轮刚发出、或者推理不画时还在想，`work` 的这一项是空的（见 `turnBlocks` 的 `live`）。 */
	runs: Run[];
	/** 一轮里按画出来的顺序排好的每一行；`plain` 时为空。 */
	items: TurnItem[];
	/**
	 * 这一块属于第几轮。
	 *
	 * 「正在做的那一段」问的是**这一轮跑完没有**，不是「这一块是不是最后一块」。按位置判，回答一开始
	 * 流式输出就判错了。
	 */
	turn: number;
}

/** 有过程的一轮里的一行：一段活（`step`），或者原样画的一条（话、页面、标记）。 */
type TurnItem = { kind: "run"; key: string; run: Run } | { kind: "step"; key: string; step: Step };

/**
 * 一段连着做的活，连同夹在中间、跟在后面的推理——画出来是一行。
 *
 * 读、跑、改、操作网页挨在一起是一段，其余的同一种挨在一起是一段（见 `joins`）；说了话另起一行。插在这样一段中间
 * 回来的后台命令结果挂在这一段上（`job`，见 `jobReturn`），不另起一行。
 *
 * 推理落在哪一段就算哪一段，放下就不再挪：「想 → 点 → 想 → 输入」是一段浏览器的活，读作「思考 2 次 ·
 * 打开网页、操作网页」。挂在一段活后面的推理就是那一段的，下一次调用换了一类也不跟过去——跟过去的话，
 * 上一行的「思考 N 次」会少一次，数往回跳。前面还没有活的推理（一轮开头、说完一句话之后）等下一次调用，
 * 跟着它开新的一段；一直没等到调用的自己是一行。
 *
 * `key` 是第一次调用的 id：一段活往后长，它不换。
 */
export interface Step {
	key: string;
	category: string;
	calls: Call[];
	members: StepMember[];
}

export type StepMember = { kind: "call"; call: Call } | { kind: "thinking" | "job"; run: Extract<Run, { kind: "message" }> };

/**
 * 一段活有没有要重画的东西——`WorkStep` 的 memo 比较。
 *
 * `turnBlocks` 每次转录变了都整个重做，每一段都是新对象；不比内容，一个工具结果落地，可见的二十轮里
 * 每一段活都要重画一遍，连同各自那七八个 store 订阅。并行工具一批六个、两百轮下来，渲染进程每轮的 CPU
 * 涨到开头的近两倍，大头就是这个（`e2e/scratch/tools-cpu-probe.ts`）。
 *
 * 调用比 `block` 本身而不是 `sameRun` 那样比 id：这一行的那句话读的是参数，参数还在流进来时 id 不变、
 * block 换了。消息只换不改，定下来的 block 引用不会变。推理和送回来的结果按 `sameRow` 的规矩比，
 * `turnStats` 比数。
 *
 * 只管内容；`live` 和画推理那一行要的外部状态由调用方另比。放在这里而不是组件里，理由同 `sameRun`。
 */
export function sameStep(before: Step, after: Step): boolean {
	if (before === after) return true;
	if (before.key !== after.key || before.category !== after.category || before.members.length !== after.members.length) return false;
	return before.members.every((member, i) => {
		const other = after.members[i];
		if (member.kind !== other.kind) return false;
		if (member.kind === "call" && other.kind === "call") {
			return member.call.block === other.call.block && member.call.stopReason === other.call.stopReason && samePage(member.call.page, other.call.page);
		}
		return member.kind !== "call" && other.kind !== "call" && sameMessageRun(member.run, other.run);
	});
}

function sameMessageRun(a: Extract<Run, { kind: "message" }>, b: Extract<Run, { kind: "message" }>): boolean {
	const keys = Object.keys(a) as (keyof typeof a)[];
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => key === "turnStats" || Object.is(a[key], b[key])) && sameStats(a.turnStats, b.turnStats);
}

/**
 * A reply row that is nothing but reasoning — a reply that thought and then only called tools.
 *
 * It gets no `lead` (there is no prose row below it to lead into), so it used to count as an
 * answer: drawn outside the fold. Rows with no reasoning in them stay out of this, above all the
 * empty row that is a failure's only trace.
 */
function thinkingOnly(run: Extract<Run, { kind: "message" }>): boolean {
	if (run.message.role !== "assistant") return false;
	const own = run.message.content.slice(run.from ?? 0, run.upTo);
	return own.some((block) => block.type === "thinking") && !own.some((block) => block.type === "text" && block.text.trim());
}

/**
 * 不显示推理（`showThinking` 关着）时的转录：只有推理的行拿掉。
 *
 * 在 Run 这一层拿，不在画的时候藏：藏起来的行仍然会让只想不做的一轮算成有过程、让一段活读成「思考 2 次 ·
 * 读取文件」，点开却什么也没有。拿掉之后，只想不做的一轮就是一句回答；被推理隔开的两段同类的活照旧
 * 合成一行（`itemsOf` 的 `step` 跨 Run 接着长）。
 *
 * 一轮停在一段推理上——想到一半被停下、或者想完没说话——那一行是这一轮的最后一行，交付卡片挂在它上面，
 * 所以留个壳：推理切掉，行还在。模型正在想的时候，底部的运行指示照旧说它在想（`RunningIndicator`）。
 */
export function withoutThinking<R extends Run>(list: R[]): R[] {
	const out: R[] = [];
	for (const run of list) {
		if (run.kind !== "message" || !thinkingOnly(run)) out.push(run);
		else if (!run.lead && run.message.role === "assistant" && settled(run.message.stopReason)) out.push({ ...run, from: run.upTo });
	}
	return out;
}

/** 过程里的一次推理。同在过程里的送达不是。 */
function reasoning(run: Run): run is Extract<Run, { kind: "message" }> {
	// `lead` 的行不因为是 `lead` 就算：开头单独拆出来的推理本来就只有推理；拆在页面前面的那一段可能有话，话不算。
	return run.kind === "message" && thinkingOnly(run);
}

/** 一条 run 是不是「人开的口」——新一轮从这里开始。 */
function opensBlock(run: Run): boolean {
	return run.kind === "command" || (run.kind === "message" && opensTurn(run.message));
}

/** 开这一轮的是一条送达。另一个会话的来信不算：它有正文要读，回它的那一轮和回人一样。 */
function wokenBy(run: Run): boolean {
	return run.kind === "message" && run.message.role === "user" && Boolean(run.message.delivery) && !run.message.peer;
}

/**
 * 一行推理是不是还在写：后面什么都还没有。
 *
 * 写着的推理落在一段活的末尾时，那一行说的是它（「正在思考 · 5s」），而不是上一步——见 `WorkStep`。
 */
export function thinkingLive(run: Extract<Run, { kind: "message" }>): boolean {
	return run.message.role === "assistant" && run.message.stopReason === "pending" && run.upTo === run.message.content.length;
}

/**
 * 互相接成一段的几类：读、跑命令、改文件、操作网页、看预览。边改边在页面上验，本来就是一件事。
 *
 * 走到这里的 preview 都是收进过程的那种（同一轮里没被发布的检查、失败的、发布那一次）；画成页面的不进 `Step`。
 * 它从前自成一类，「改一次、检查一次」的一段就被切成命令一行、预览一行地交替排下去。
 */
const MERGES = new Set(["explore", "terminal", "files", "browser", "preview"]);

/**
 * MCP 的工具不论哪个服务器都算一类。名字是 `mcp__<服务器>__<工具>`，可超长的会换成哈希（core 的
 * `mcp/names.ts`），从名字里拆不出可靠的服务器。
 */
function kindOf(category: string): string {
	return category.startsWith("mcp__") ? "mcp" : category;
}

/**
 * 这次调用接不接在这一段后面。
 *
 * `MERGES` 里的几类互相接；浏览器从前只和浏览器合，边改边在页面上验的一段就是「读文件 → 操作网页 → 改文件 →
 * 操作网页」来回跳的几行，所以它也进了这里。其余的只和同一种接：连着两次清单、连着通知几个会话是一件事，
 * 清单夹在两段活中间、Skill 跟着一次问人，各是一件要单独看见的事，并进一段活里回头就找不到了。
 * 派发也是这样：子代理那一行带着它们的脸，人是盯着它看的。
 */
function joins(step: Step, category: string): boolean {
	if (MERGES.has(step.category) && MERGES.has(category)) return true;
	return kindOf(step.category) === kindOf(category);
}

/**
 * 插在一轮中间、只带着后台命令结果的送达。
 *
 * 回来时正在做的是 `MERGES` 那一段，就挂在它上面：放到后台的那次 `bash` 当场就以「已放到后台」跑完了，
 * 结果单独一行等于把同一条命令说两遍，还把这一段切成两截。别的时候（刚说完话、在清单这类调用后面）
 * 照旧自己一行：挂到 Skill、清单那一行上就成了不相干的两件事，等下一次调用再挂又会先冒一行再收走。
 * 子代理的结果和另一个会话的来信不在此列：主智能体接下来那段话是就着它们说的，见 `DeliveryRow`。
 */
function jobReturn(run: Run): run is Extract<Run, { kind: "message" }> {
	// 叫醒会话的那一种开了一轮（`opensTurn`），不挂；另一个会话的来信有正文要读，也不挂。
	if (run.kind !== "message" || run.message.role !== "user" || run.message.peer || opensTurn(run.message)) return false;
	const reports = run.message.delivery ?? [];
	return reports.length > 0 && reports.every((report) => report.kind === "job");
}

/** 只带后台命令结果的那条送达里的几条结果；别的 run 是 `null`。 */
function jobsOf(run: Run): DeliveredReport[] | null {
	return jobReturn(run) && run.message.role === "user" ? (run.message.delivery ?? []) : null;
}

/** 这条送达再添上几条结果。是一份新的 run：原来那条还是转录里的那条。 */
function withJobs(run: Run, more: DeliveredReport[]): Run {
	if (run.kind !== "message" || run.message.role !== "user") return run;
	return { ...run, message: { ...run.message, delivery: [...(run.message.delivery ?? []), ...more] } };
}

/**
 * `live`：最后一轮还在跑。人开的这一轮从发出就算有过程。
 *
 * 一轮要等到第一次推理或工具调用才算有过程，在那之前说的第一句话是 `plain`，有了过程就被挪进 `work` 重挂一遍。
 * 只在「想过」时提前算不够：推理不画时推理行先被拿掉，而有的模型（经代理的 GPT）根本不把推理流出来，第一次
 * 工具调用之前什么也问不出。发出的那一刻没法知道这一轮会不会有过程，所以不问。`work` 没有标题（见
 * `TurnWork`），看上去和 `plain` 一样；跑完了还是没有过程的一轮照旧退回一句回答。后台结果叫醒的一轮、压缩命令
 * 开的一轮不这样分。
 */
export function turnBlocks(list: Run[], live = false): TurnBlock[] {
	const out: TurnBlock[] = [];
	let turn = 0;
	// 这一轮是人开的口：后台结果叫醒的、压缩命令开的都不算。
	let asked = false;
	const plain = (run: Run) => out.push({ kind: "plain", runs: [run], items: [], turn });

	let at = 0;
	while (at < list.length) {
		if (opensBlock(list[at])) {
			asked = list[at].kind === "message" && !wokenBy(list[at]);
			turn++;
			plain(list[at++]);
			continue;
		}
		let end = at;
		while (end < list.length && !opensBlock(list[end])) end++;
		const body = list.slice(at, end);
		/*
		 * 只有重连这类标记、没有一次推理或工具的一轮，原样摊开。
		 *
		 * 检查的那一页从写第一笔起就算：它后面要么是一次发布、要么是它自己收进过程，这一轮早晚是有过程的。
		 * 等到那时才换成有过程的一轮，页面就换了一个父元素，重新挂一遍、闪一下。
		 */
		if ((live && asked && end === list.length) || body.some((run) => (run.kind === "tools" && (!run.shown || run.calls.some((call) => call.page))) || reasoning(run))) {
			out.push({ kind: "work", runs: body, items: itemsOf(body), turn });
		} else for (const run of body) plain(run);
		at = end;
	}
	// 刚发出、或者还在想：这一轮还什么也没有（推理不画时推理行已经拿掉），先占住 `work` 的位置。
	if (live && asked && list.length > 0 && opensBlock(list[list.length - 1])) out.push({ kind: "work", runs: [], items: [], turn });
	return out;
}

/**
 * 一条 bash 的命令还在生成：先不画，命令到齐时直接出现在它该在的那一段里。
 *
 * 归哪一类要看命令（`toolCategory`），而参数没生成完时 `arguments` 是空的，只有 `argumentsText` 在长（见各家
 * provider 的 `toolcall_end`）。按空参数先算终端，一条 `sed -n` 会先在底下冒一行、几百毫秒后再并进上面的探索；
 * 按写了一半的命令算也不行：`se` 还不是 `sed`，`cat > f <<EOF` 写到 `>` 之前像是在读。ZCode 也是这么做的。
 * 代价是生成一条长命令（大段 heredoc）的那几秒里，这条调用还不在转录上，底部运行指示的计时照走。
 */
function unclassified(call: Call): boolean {
	return call.block.name === "bash" && call.stopReason === "pending" && typeof call.block.arguments?.command !== "string";
}

function itemsOf(body: Run[]): TurnItem[] {
	const items: TurnItem[] = [];
	// 断言而不是标注：循环里 TS 把它收窄成初值 `null`，看不见循环后半段的赋值。
	let step = null as Step | null;
	// 前面还没有活时想过的推理：等下一次调用来开一段。
	let thoughts: Extract<Run, { kind: "message" }>[] = [];
	const settle = () => {
		for (const run of thoughts) items.push({ kind: "run", key: runKey(run), run });
		thoughts = [];
	};
	for (const run of body) {
		if (run.kind === "tools" && !run.shown) {
			for (const call of run.calls) {
				if (unclassified(call)) continue;
				const category = toolCategory(call.block.name, call.block.arguments);
				const before = thoughts.map((thought) => ({ kind: "thinking" as const, run: thought }));
				thoughts = [];
				if (step && joins(step, category)) {
					step.calls.push(call);
					step.members.push(...before, { kind: "call", call });
					continue;
				}
				step = { key: `step-${call.block.id}`, category, calls: [call], members: [...before, { kind: "call", call }] };
				items.push({ kind: "step", key: step.key, step });
			}
			continue;
		}
		if (reasoning(run)) {
			if (step) step.members.push({ kind: "thinking", run });
			else thoughts.push(run);
			continue;
		}
		if (step && MERGES.has(step.category) && jobReturn(run)) {
			step.members.push({ kind: "job", run });
			continue;
		}
		settle();
		step = null;
		const last = items[items.length - 1];
		// 挨着自己一行的后台命令结果并成一行（`JobDelivery` 本来就会说「N 个后台命令结束」），key 跟第一条走。
		const jobs = jobsOf(run);
		if (jobs && last?.kind === "run" && jobsOf(last.run)) {
			last.run = withJobs(last.run, jobs);
			continue;
		}
		items.push({ kind: "run", key: runKey(run), run });
	}
	settle();
	return items;
}
