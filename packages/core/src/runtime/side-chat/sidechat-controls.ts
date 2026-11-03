import { textResult } from "../../agent/tool-run.ts";
import type { Tool } from "../../types.ts";
import type { MainSession } from "./side-main.ts";

/**
 * 侧边聊天自己判断该交出去、人没指定去哪时，留给卡片的东西：人在卡片上选交给主会话、开新会话，
 * 还是就在侧边聊天里做。写进工具结果的 `details`，日志留着，重开面板卡片还在。
 */
export interface DispatchSuggestionDetails {
	kind: "dispatch_suggestion";
	title: string;
	instruction: string;
}

/** 卡片标题按人数字的方式数（码点）。没给标题就用指令的开头。 */
const TITLE_MAX = 60;

function cardTitle(title: unknown, instruction: string): string {
	const given = typeof title === "string" ? title.trim() : "";
	const chars = [...(given || instruction.split("\n")[0]!)];
	return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("")}…` : chars.join("");
}

/**
 * Handing work to the main session instead of doing it here.
 *
 * The side chat can change files itself; this is for work that belongs to what the main session
 * is doing. Where it goes is the person's call, not the model's: only when they said to hand it to
 * the main session (`user_asked`) is it queued at once. Otherwise it is a card offering the main
 * session, a new session or this side chat — a dispatch lands in the main session's history and
 * runs at once when it is idle, which is not something to do on a guess. Queued work runs under
 * the same approval rules as anything the user typed themselves.
 */
export function dispatchTaskTool(main: MainSession, sideId: () => string): Tool<{ instruction: string; title?: string; user_asked?: boolean }> {
	return {
		name: "dispatch_task",
		description:
			"把一件需要动手的事交出去（改文件、跑命令、查代码等）。" +
			"用户明确说了交给主会话（「让主会话做」「交给主会话」）时 user_asked 为 true：直接排进主会话的队列，它在完成当前工作后执行。" +
			"其余情况 user_asked 为 false：什么都不会开始，侧边聊天里出现一张卡片，由用户选择交给主会话、开一个新会话，还是就在这里做；调用后简短告诉用户卡片在等他选，然后结束这一轮。" +
			"instruction 必须是一条完整、可独立执行的指令——主会话和新会话都看不到侧边聊天的上下文。",
		parameters: {
			type: "object",
			properties: {
				instruction: {
					type: "string",
					description: "交出去的完整指令，写成可以直接执行的一句话或一段话。",
				},
				title: {
					type: "string",
					maxLength: TITLE_MAX,
					description: "卡片标题：以动词开头的短语，不超过 60 字；选开新会话时也是新会话的名字。",
				},
				user_asked: {
					type: "boolean",
					description: "用户是否明确要求交给主会话。只在他说过时为 true，你自己判断该交出去的一律 false。",
				},
			},
			required: ["instruction", "user_asked"],
		},
		summarize: (args) => `${args.user_asked === true ? "派给主会话" : "建议交出去"}：${String(args.instruction ?? "").slice(0, 40)}`,
		async execute(args) {
			const instruction = String(args.instruction ?? "").trim();
			if (!instruction) return textResult("指令为空，没有派出任何任务。");
			if (args.user_asked !== true) {
				const details: DispatchSuggestionDetails = { kind: "dispatch_suggestion", title: cardTitle(args.title, instruction), instruction };
				// 模型得听清楚什么都没开始：一张等人点的卡片，从它这边看和已经派出去一模一样。
				return textResult("什么都还没开始：侧边聊天里有一张卡片，等用户选交给主会话、开新会话，还是就在这里做。简短告诉用户这件事，然后结束这一轮。", details);
			}
			const task = await main.enqueueTask(instruction, "side-chat", sideId());
			return textResult(
				main.running
					? "已排入主会话的任务队列，它会在当前工作完成后执行。"
					: "主会话当前空闲，已经开始执行。",
				task,
			);
		},
	};
}

/**
 * Reaching the main session's controls, rather than its queue.
 *
 * `dispatch_task` is for work: it goes to the back of the queue and runs when the session is free.
 * That is exactly wrong for the things you say *about* a run in progress. Asked to pause, the side
 * chat had only the queue to reach for — so 「请暂停手头的所有自动执行任务」 was filed behind the
 * very work it was asking to stop, and would have been carried out, if at all, once there was
 * nothing left to pause. The panel reported success and nothing happened.
 *
 * These take effect immediately, because that is what a control is. They cannot change a file, run
 * a command or read anything: the whole surface is stop, carry on, and what is it doing.
 */
export function controlMainTool(main: MainSession): Tool<{ action: string; discardPlan?: boolean }> {
	return {
		name: "control_main",
		description:
			"立即控制主会话的执行状态，不排队、马上生效。" +
			"pause：让主会话停下手头正在跑的工作（和用户点暂停按钮一样）。" +
			"用户明确取消旧目标时，pause 配合 discardPlan: true 可同时废除旧清单；单纯暂停不要清除清单。" +
			"resume：让它接着做——如果有被暂停时中断的派出任务，会把那个任务重新排上，否则让它从中断处继续。" +
			"status：查主会话现在是在忙还是空着，以及队列里还剩什么。" +
			"需要它去『做』一件新的事，用 dispatch_task，不要用这个。",
		parameters: {
			type: "object",
			properties: {
				discardPlan: { type: "boolean", description: "Only with pause, when the user explicitly cancels or replaces the old task plan." },
				action: {
					type: "string",
					enum: ["pause", "resume", "status"],
					description: "pause 暂停，resume 继续，status 查看当前状态。",
				},
			},
			required: ["action"],
		},
		summarize: (args) => {
			const action = String(args.action ?? "");
			if (action === "pause") return "让主会话停下";
			if (action === "resume") return "让主会话接着做";
			return "查看主会话状态";
		},
		async execute(args) {
			const action = String(args.action ?? "").trim();

			if (action === "pause") {
				if (args.discardPlan === true) {
					await main.discardTaskPlan();
					return textResult("主会话已停止，旧任务清单已取消。历史记录保留，未完成事项没有被标记为完成。");
				}
				// 看 `idle` 不看 `running`：这一轮收了尾，派出去的子代理照样在后台跑，主窗口的停止键也停它们。
				if (main.idle) return textResult("主会话现在没有在执行任何东西，不需要暂停。");
				const running = main.running;
				main.abort();
				return textResult(
					running
						? "已经让主会话停下了。它手头的工作已中止，派出的任务也一并中断——需要的话可以让我继续。"
						: "主会话这一轮已经收尾，但后台还有它派出去的活没回来——已经一并停下。需要的话可以让我继续。",
				);
			}

			if (action === "resume") {
				/*
				 * A task interrupted by the pause is what "carry on" means, when there is one.
				 *
				 * Pausing cancels the dispatched task along with the turn, and resuming only the
				 * conversation leaves that task cancelled — the work the panel asked for silently
				 * never happens. Same rule the main window's 继续 follows.
				 */
				const interrupted = main.interruptedTask();
				if (interrupted) {
					await main.resumeTask(interrupted.id);
					return textResult(`已把被中断的任务重新排上：${interrupted.text.slice(0, 60)}`);
				}
				if (main.running) return textResult("主会话正在执行，不用继续。");
				// 派出去的还没回来：结果回来时它自己会开一轮。这时让它「接着做」，它多半会把那些活自己重做一遍。
				if (!main.idle) return textResult("主会话派出去的活还在后台跑，结果回来后它会自己接着做，不用继续。");
				/*
				 * `synthetic`, because nobody typed it.
				 *
				 * It keeps the sentence out of the transcript — the user pressed nothing and wrote
				 * nothing — and keeps the turn's elapsed time and tokens counting from where the work
				 * actually started rather than restarting at this message.
				 */
				/*
				 * 不等：`prompt` 要等主会话这一轮连同排在后面的都跑完才返回，那可能是几十分钟——侧边聊天
				 * 这次工具调用就一直挂着，人对它说的话只能排在后面。控制是当场生效的，结果在主会话里看。
				 */
				void main.prompt([{ type: "text", text: "继续，从中断的地方接着做。" }], { synthetic: true }).catch(() => {});
				return textResult("已经让主会话接着做了。");
			}

			if (action === "status") {
				const queued = main.taskQueue.filter((t) => t.status === "queued").length;
				const running = main.taskQueue.find((t) => t.status === "running");
				const interrupted = main.interruptedTask();
				const parts = [main.running ? "主会话正在执行" : main.idle ? "主会话当前空闲" : "主会话这一轮已经收尾，后台还有它派出去的活没回来"];
				if (running) parts.push(`正在跑派出的任务：${running.text.slice(0, 40)}`);
				if (queued > 0) parts.push(`队列里还有 ${queued} 个任务在等`);
				if (interrupted) parts.push(`有一个被中断的任务可以继续：${interrupted.text.slice(0, 40)}`);
				return textResult(parts.join("；") + "。");
			}

			return textResult(`不认识的动作「${action}」。可用的是 pause、resume、status。`);
		},
	};
}
