/**
 * 后台跑完的东西，作为一条消息回到主会话时长什么样：子代理的结果、自己结束了的后台命令、`monitor`
 * 送来的新输出、从建议卡片上开出来的会话交回的第一轮。什么时候送、攒多久见 `session-deliveries.ts`。
 */

import type { MonitorEvents } from "../../tools/background-jobs.ts";
import type { DeliveredReport, Message } from "../../types.ts";
import type { SubAgentSummary } from "../../types/sub-agent.ts";
import type { SettledDispatch } from "../sub-agent/detached-dispatches.ts";

/**
 * 一个自己结束了的后台命令（`bash` 的 `run_in_background`，或超时转到后台的那些）。
 *
 * 和子代理的结果走同一条送达：模型不用再拿 `bash_output` 一遍遍去问「好了没」，每问一次都是一整轮
 * 请求；这一轮已经说完的时候，它跑完了也有人把会话叫醒。`status` 和 `output` 是替模型做的那一次
 * 读取（见 `readJob`），所以之后再读不会重发同一段。
 */
export interface FinishedJob {
	id: string;
	command: string;
	description?: string;
	exitCode: number | null;
	status: string;
	failed: boolean;
	output: string;
}

/**
 * 一个从建议卡片上开出来的会话跑完了第一轮，按它被要求的交回来（桌面端的 `spawn_session` 的 `reportBack`）。
 *
 * 它不是子代理：人看得见它、能在里面插话，跑完它还在。交回的是它最后那段回复，和子代理的结果走同一条
 * 送达，所以父会话闲着时一样被叫醒、忙着时一样插进这一轮。
 */
export interface FinishedSession {
	sessionId: string;
	title: string;
	status: "done" | "failed";
	reply: string;
}

/** 送达消息里一份报告需要的东西：跑完的结果，和登记簿上它是谁。 */
export interface DeliveryItem {
	report: SettledDispatch;
	/** 登记簿里的那一条；被挤出名单的（极少）没有，就只剩结果本身。 */
	summary: Pick<SubAgentSummary, "agent" | "description" | "status" | "incomplete"> | null;
}

/**
 * 后台子代理的结果，作为一条消息回到主会话。
 *
 * 给模型读的那一份是结果原文，外面套一层标签说清是谁、干的什么、怎么收场的。末尾那句话分两种：
 *
 * - 还有没回来的（`pending`）：只就这几份说清带来了什么、还在等谁，不写最终回答。点名还在等的是
 *   谁，模型才不会把「第一份到了」当成「都到了」去收尾，也不会自己动手去补还没回来的那一份。
 * - 都回来了：这是材料，不是成品——合并成一份按问题组织的回答。几份一起到时，模型最顺手的写法是
 *   按人头逐个转述（「子智能体 2 做了什么」），那是把它自己该做的合并推给了读的人。
 *   模型若已抢先交过完整回答（没等结果就收了尾），只说材料改变了什么：一律「合并成一份」时，它把
 *   万字方案整份重写了一遍，人读到两份大半相同的长文。有没有答过由模型看自己的历史判断——运行时
 *   分不清收尾那句是「派出去了，等结果」还是一份完整回答。
 *
 * `delivery` 给界面：画成一行「谁的结果到了」，不是一个人发的气泡。
 */
export function deliveryMessage(
	items: DeliveryItem[],
	jobs: FinishedJob[] = [],
	pending: Pick<SubAgentSummary, "agent" | "description">[] = [],
	sessions: FinishedSession[] = [],
	monitors: MonitorEvents[] = [],
): Message {
	const blocks = items.map(({ report, summary }) => {
		const status = report.error ? "failed" : (summary?.status ?? "done");
		const body = report.error ? `它没能跑完：${report.error}` : report.answer?.text || "（它跑完了，但什么都没交回来。）";
		const attrs = [
			`id="${report.id}"`,
			summary ? `agent="${attribute(summary.agent)}"` : "",
			summary ? `task="${attribute(summary.description)}"` : "",
			`status="${status}"`,
		].filter(Boolean);
		return `<subagent_result ${attrs.join(" ")}>\n${body}\n</subagent_result>`;
	});
	const delivery: DeliveredReport[] = items.map(({ report, summary }) => ({
		id: report.id,
		agent: summary?.agent ?? "",
		description: summary?.description ?? "",
		status: report.error ? "failed" : summary?.status === "failed" || summary?.status === "aborted" ? summary.status : "done",
		...(report.answer?.incomplete || summary?.incomplete ? { incomplete: true } : {}),
	}));
	const jobReports: DeliveredReport[] = jobs.map((job) => ({
		id: job.id,
		kind: "job",
		agent: "",
		description: job.description || job.command,
		command: job.command,
		exitCode: job.exitCode,
		status: job.failed ? "failed" : "done",
	}));
	const agentParts =
		items.length === 0
			? []
			: [
					"（运行时送达）你之前派出去的子代理有结果了：",
					...blocks,
					pending.length > 0
						? `还有 ${pending.length} 个没回来：${pending.map((one) => `${one.agent}（${one.description}）`).join("、")}。它们跑完也会这样送到。` +
							"现在只就上面这几份用一两句话告诉用户：带来了什么结论、还在等哪几个——不要写最终回答，也不要自己去做它们正在做的事。"
						: "派出去的都回来了。这些是交给你的材料，不是给用户的成品：结合之前送到的和用户后来说的话接着做。" +
							"派出之后你如果已经给过用户完整的回答，不要把它重写一遍：只说这些材料改变了什么——新增的、修正的、推翻了之前哪条结论；什么都没改变就用一句话说明。" +
							"还没回答过的，需要回答用户时，把结论合并成一份按问题组织的回答——去重、核对关键结论，不要逐个转述「某个子代理做了什么」。",
				];
	const jobParts =
		jobs.length === 0
			? []
			: [
					"（运行时送达）你之前放到后台的命令结束了。下面是它的退出状态和你上次读取之后的输出，不用再拿 bash_output 去查：",
					...jobs.map((job) => `<background_job id="${job.id}" command="${attribute(job.command)}" status="${attribute(job.status)}">\n${job.output}\n</background_job>`),
				];
	/*
	 * `monitor` 的一批新输出。界面上和后台命令结束同一种行（`kind: "job"`），点了同样去任务面板；
	 * `monitor` 告诉它这是一批输出，不是结束。
	 */
	const monitorReports: DeliveredReport[] = monitors.map((one) => ({
		id: one.id,
		kind: "job",
		agent: "",
		description: one.description || one.command,
		command: one.command,
		status: "done",
		monitor: { lines: one.lines, ...(one.stopped ? { stopped: one.stopped } : {}) },
	}));
	const monitorParts =
		monitors.length === 0
			? []
			: [
					"（运行时送达）你用 monitor 监视的命令有新输出，下面是上次送达之后的新行，不用拿 bash_output 去查。" +
						"只在这些输出需要你处理时才行动，否则一句话带过；用不着它了就用 bash_output 加 kill: true 停掉：",
					...monitors.map(monitorBlock),
				];
	const sessionReports: DeliveredReport[] = sessions.map((one) => ({ id: one.sessionId, kind: "session", agent: "", description: one.title, status: one.status }));
	const sessionParts =
		sessions.length === 0
			? []
			: [
					"（运行时送达）你之前建议另开、用户点了开始的会话跑完了第一轮。下面是它最后的回复；那个会话还在，用户可以接着在那里跟它说话：",
					...sessions.map((one) => `<session_result id="${one.sessionId}" title="${attribute(one.title)}" status="${one.status}">\n${one.reply || "（它没有留下回复。）"}\n</session_result>`),
					"就着这份结果接着做你手上的事：说清它带来了什么、要不要因此改你正在做的。它做过的事不要再做一遍。",
				];
	return {
		role: "user",
		synthetic: true,
		timestamp: Date.now(),
		delivery: [...delivery, ...jobReports, ...monitorReports, ...sessionReports],
		/*
		 * 一份报告一个文本块：发送前和 `task` 当场交回的结果按同一条线剪（见 `pruneMessage`），分块时
		 * 只剪超长的那份，几份一起到的时候不会把夹在中间的整份剪掉。
		 */
		content: [...agentParts, ...jobParts, ...monitorParts, ...sessionParts].map((text) => ({ type: "text" as const, text })),
	};
}

/** 一批 monitor 输出：丢了多少行、为什么停了，都写在标签里面，模型读到的和它看见的行在一处。 */
function monitorBlock(one: MonitorEvents): string {
	const dropped = one.dropped > 0 ? [`[更早的 ${one.dropped} 行超出单次送达的上限，没有放进来${one.outputPath ? `；完整输出在 ${one.outputPath}` : ""}]`] : [];
	const stopped =
		one.stopped === "max_events"
			? [`[监视已停止：输出满了 max_events 的 ${one.limit} 行，进程已结束]`]
			: one.stopped === "idle"
				? [`[监视已停止：${Math.round((one.limit ?? 0) / 1000)} 秒没有新输出（idle_timeout），进程已结束]`]
				: [];
	const body = [...dropped, ...(one.text ? [one.text] : []), ...stopped].join("\n");
	return `<monitor_events id="${one.id}" command="${attribute(one.command)}" lines="${one.lines}" status="${one.stopped ? "stopped" : "running"}">\n${body}\n</monitor_events>`;
}

/** 标签属性里的值：引号换掉，换行压平，免得一句描述把标签撑破。 */
function attribute(value: string): string {
	return value.replace(/"/g, "'").replace(/\s+/g, " ").trim();
}
