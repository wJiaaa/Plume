import { errorResult } from "./result.ts";
import type { Tool, ToolResult } from "../types.ts";

export { BUILTIN_AGENTS, type AgentDefinition } from "../agents-builtin.ts";
import type { AgentDefinition } from "../agents-builtin.ts";

export const AGENTS_KEY = "agents";

interface TaskArgs {
	description: string;
	prompt: string;
	subagent_type?: string;
	resume?: string;
}

/**
 * Delegate work to a nested agent with its own context window.
 *
 * The point is context isolation: a search that reads forty files returns one paragraph to
 * the parent instead of forty file dumps.
 *
 * 什么活值得派，写在描述里，而且是固定的一段：不随推理等级、设置或这一轮说了什么变化。以前这件事
 * 放在系统提示里按推理等级换五种说法，档位变一次，提示词就要补发一次增量；而高档那几句「可以主动
 * 派」「放开编排」只说了倾向、没说标准，量到的是主代理把「给刚写的函数补测试」也派了出去——为了派，
 * 先在推理里把接口约定一条条写死，子代理从零开始又设计一遍。
 *
 * 最后一句是写入归属：同一个文件只有一个写入方。并行改同一批文件的两个子代理互相覆盖，派完接着做
 * 的父会话也可能去改子代理正在改的那个——这里不加锁，按文件划清是协作约定，见 ADR-0057。
 *
 * 「结论依赖它们」那句要写在描述里：只写在「已派出」的工具结果里，模型接着读上六到八次请求就忘了，
 * 把写最终回答也算成「不依赖它们的事」（见 `agent/awaiting.ts`）。描述每次请求都在，而且走缓存。
 */
export const taskTool: Tool<TaskArgs> = {
	name: "task",
	description:
		"Run a sub-agent in its own context window, in the background. The call returns at once; when the sub-agent finishes, its final answer arrives as a message of its own, one per sub-agent. " +
		"It starts from nothing — your `prompt` is all it knows, and it cannot ask you questions. " +
		"Two kinds of work are worth delegating: work whose intermediate output is large and whose conclusion is all you need (sweeping dozens of files for one answer, running something with long output for its failures), " +
		"and a sizeable piece of work that does not depend on what you are doing. " +
		"Do everything else yourself: a change of a step or two, part of what you are writing now (such as tests for the function you just wrote), " +
		"or work you could only hand off after spelling out its interfaces and conventions — spelling those out costs as much as doing it. " +
		"Agents with write tools edit files directly; their risky actions are asked of the user here, like yours. " +
		"Calls in one reply run in parallel (extra ones queue), so dispatch independent pieces together; have each skip builds, lints and tests, and verify once yourself after they have all reported. " +
		"While they run, do not wait, poll or redo their work: carry on with anything that does not depend on them, or tell the user in a sentence what you dispatched and end your turn. " +
			"Your conclusion depends on them: write no final answer or summary, and never guess what they will find, until every sub-agent you dispatched has reported. " +
		"Pieces that need a shared interface which does not exist yet are not independent — write the interface first, or do not split. " +
		"Each file has one writer: when sub-agents may edit files, name in each prompt the files it owns, and never give two of them the same file; while one is editing its files, do not edit them yourself.",
	parameters: {
		type: "object",
		properties: {
			description: { type: "string", description: "3-5 word summary of the task." },
			prompt: {
				type: "string",
				description: "Self-contained instructions for the sub-agent. When resuming, what it should do next.",
			},
			subagent_type: { type: "string", description: "Which agent definition to use. Defaults to `general`. Ignored when resuming." },
			resume: {
				type: "string",
				description:
					"Id of a sub-agent you dispatched earlier (given at the end of its result). It continues with its whole context, and `prompt` is what you tell it next. " +
					"Use it rather than dispatching the same work again, including for one that stopped before finishing.",
			},
		},
		required: ["description", "prompt"],
		additionalProperties: false,
	},
	summarize: (args) => args.description ?? "Sub-agent task",

	async execute(args, ctx): Promise<ToolResult> {
		if (!ctx.spawnSubAgent) return errorResult("Sub-agents are not available in this session.");
		if (typeof args.prompt !== "string" || !args.prompt.trim()) return errorResult("`prompt` is required.");

		/*
		 * `undefined` and `[]` mean different things, and conflating them switched the check off.
		 *
		 * `undefined` is a session that never registered a roster — a CLI path, a test — where
		 * refusing every name would break a caller doing its own resolution. `[]` is a session that
		 * registered one and it is empty, where the only honest answer to any name is that it does
		 * not exist. The old `agents.length > 0` guard read the two the same way, so in the empty
		 * case every name passed and a typo came back as a `general` sub-agent doing something
		 * adjacent to what was asked.
		 */
		const agents = ctx.state.get(AGENTS_KEY) as AgentDefinition[] | undefined;
		/*
		 * 续跑：它是谁由它当初被派出去时定下，不看这次的 `subagent_type`。找不到、还在跑、上下文已经
		 * 没了，`runSubAgent` 上名单之前就拒了，拒绝的话原样作为工具错误交回（见下面的 `catch`）。
		 */
		const resuming = typeof args.resume === "string" && args.resume.trim() ? args.resume.trim() : undefined;
		const requested = args.subagent_type ?? "general";
		if (!resuming && agents && !agents.some((a) => a.name === requested)) {
			const available = agents.length > 0 ? agents.map((a) => a.name).join(", ") : "none are defined in this session";
			return errorResult(`Unknown subagent_type "${requested}". Available: ${available}.`);
		}

		try {
			const answer = await ctx.spawnSubAgent({
				description: args.description ?? "Sub-agent task",
				prompt: args.prompt,
				agentType: requested,
				...(resuming ? { resume: resuming } : {}),
			});
			/*
			 * 派出即放手：这里拿到的是「已派出」那句话和它的 id，结论稍后作为一条消息送回来
			 * （`detached-dispatches.ts`）。卡片据此跟着登记簿画它的实时状态。
			 */
			return {
				content: [{ type: "text", text: answer.text }],
				details: {
					kind: "task",
					description: args.description,
					...(answer.id ? { subAgentId: answer.id } : {}),
					...(resuming ? { resumed: true } : { agentType: requested }),
					...(answer.detached ? { detached: true } : {}),
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// 续跑被拒是一句该据以行动的话（找不到、还在跑、不是你派的），不是一次「失败」。
			return errorResult(resuming ? message : `Sub-agent failed: ${message}`);
		}
	},
};
