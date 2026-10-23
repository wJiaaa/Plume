/**
 * `/review` 在桌面端的那一半：写代码的会话不审自己，另开一个审阅会话去审；审完问它修哪几条，由审阅会话修，报告交回来。
 *
 * 为什么另开：审的就是写的那个会话时，它带着「为什么这么写」的全部上下文，容易认同自己；读 diff、派
 * 子智能体、核实又都压在实现的上下文上。所以原会话只填一份交接单、调 `review_session`；这里看到那次调用
 * 结束，就在同一个目录里开审阅会话、发出第一条消息（交接单加上运行时取的计划和用户原话，见
 * `review-brief.ts`），并打开交回（`spawnedFrom.reportBack`，`session-report-back.ts`）。人敲 `/review`
 * 就是同意，所以不经建议卡片。设计见 ADR-0058；正文的两半见 core 的 `commands/review.ts`。
 */

import { errorResult, resolveModel, type AgentEvent, type Message, type SessionMeta, type Settings, type Tool, type ToolResult } from "@plume/core";
import { agentProfile } from "@plume/core/model-choice";
import { latestApprovedPlan, renderPlan } from "@plume/core/plan-view";
import { REVIEW_SESSION_TOOL, type ReviewSessionDetails } from "../../shared/session-suggestion.ts";
import { nativeText } from "../i18n.ts";
import { peerAddress, peerRef } from "../peer/index.ts";
import { reviewHandoff, reviewPrompt } from "./review-brief.ts";

/** Counted in code points, like the suggestion card's title. */
const TITLE_MAX = 60;
const TARGET_MAX = 2_000;
const EFFORTS = new Set(["low", "medium", "high"]);

type ReviewArgs = Record<string, unknown>;

/** The same test the `/review` instructions apply to a target in their step 1: a number, `#123`, or a pull request URL. */
export function isPullRequestTarget(target: string): boolean {
	return /^#?\d+$/.test(target) || /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(target);
}

function clip(text: string, max: number): string {
	const points = [...text.replace(/\s+/g, " ").trim()];
	return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

function optional(value: unknown, name: string, max: number): string | undefined | { error: string } {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { error: `${name} must be text.` };
	const text = value.trim();
	if (!text) return undefined;
	const length = [...text].length;
	return length > max ? { error: `${name} is ${length} characters; keep it to ${max}.` } : text;
}

/** What the call asks for, or why it cannot be used — said so the model can send it again, fixed. */
export function reviewRequest(args: ReviewArgs, parentTitle: string): ReviewSessionDetails | { error: string } {
	const target = optional(args.target, "target", TARGET_MAX);
	if (typeof target === "object") return target;
	if (args.effort !== undefined && (typeof args.effort !== "string" || !EFFORTS.has(args.effort))) return { error: "effort must be one of low, medium, high." };
	const effort = args.effort as ReviewSessionDetails["effort"];
	// 审 PR 没有实现可交接；其余都得有一份——审阅会话少了它，就只能从 diff 去猜这次想做什么。
	const handoff = reviewHandoff(args, Boolean(target && isPullRequestTarget(target)));
	if (handoff && "error" in handoff) return handoff;
	const subject = clip(target ?? parentTitle, TITLE_MAX) || nativeText("review.localChanges");
	return {
		kind: "review_session",
		title: clip(nativeText("review.sessionTitle", { title: subject }), TITLE_MAX),
		subject,
		...(target ? { target } : {}),
		...(effort ? { effort } : {}),
		...(handoff ? { handoff } : {}),
	};
}

/**
 * 审阅用哪个模型：设置 › 智能体里给 `review` 选过、这台机器上找得到的那个优先，否则沿用原会话的。
 * 选过就听它的，因为同一个模型审自己写的东西容易得到认同——换一个模型家族正是那一栏存在的理由。
 */
export function reviewModelId(settings: Settings, parentModelId: string): string {
	const chosen = agentProfile(settings, "review").modelId;
	return chosen && resolveModel(settings, chosen) ? chosen : parentModelId;
}

/**
 * 那件工具。它只校验、写下 `details` 并结束这一轮；会话由 `startReviewSessions` 在这次调用结束后开——
 * 那时才有调用 id，侧栏和对话里那一行靠它把审阅会话认作这次调用开出来的。
 */
export function createReviewSessionTool(host: { meta(sessionId: string): SessionMeta | undefined }): Tool<ReviewArgs> {
	return {
		name: REVIEW_SESSION_TOOL,
		/*
		 * Kept to the bare minimum: every main conversation carries it in its request prefix, always — registering it only
		 * when `/review` runs would change the tool table mid-conversation and throw away the prefix cache (ADR-0044).
		 * What each field takes is in step H of the `/review` instructions, which is only read when it is needed.
		 */
		description: "Hand this conversation's review to a new read-only review session; its report comes back here. Use only as step H of the `/review` instructions says to.",
		parameters: {
			type: "object",
			properties: {
				background: { type: "string" },
				decisions: { type: "string" },
				implementation: { type: "string" },
				files: {
					type: "array",
					items: { type: "object", properties: { path: { type: "string" }, change: { type: "string" } }, required: ["path", "change"] },
				},
				out_of_scope: { type: "string" },
				unverified: { type: "string" },
				focus: { type: "string" },
				target: { type: "string" },
				effort: { type: "string", enum: ["low", "medium", "high"] },
			},
			additionalProperties: false,
		},
		sessionOnly: true,
		executionMode: "sequential",
		summarize: (args) => `Review session ${typeof args.target === "string" ? args.target.trim() : ""}`.trim(),
		async execute(args, ctx): Promise<ToolResult> {
			// `sessionOnly` keeps it from sub-agents already; a list rebuilt some other way still must not start one under a sub-agent's id.
			if (ctx.sessionId.includes(":sub:")) return errorResult("Only the conversation itself can hand off its review; run the review here instead.");
			const meta = host.meta(ctx.sessionId);
			if (!meta) return errorResult("This conversation is not open in the app; run the review here instead.");
			// 审阅会话自己也是主会话、也拿得到这件工具。再交一次就是一串互相转交、谁也不审的会话。
			if (meta.spawnedFrom?.review) return errorResult("This conversation is the review session. Run the review pipeline here; do not hand it off again.");
			const request = reviewRequest(args, meta.title);
			if ("error" in request) return errorResult(request.error);
			return {
				content: [
					{
						type: "text",
						text:
							`Review handed to a new review session, "${request.title}". It starts now with your hand-off${request.handoff ? "" : " (none: a pull request)"}, the person's messages and the approved plan, if this conversation has one. ` +
							"Before it reports, it asks you which findings to fix (step H); it makes the fixes. Its report is delivered here as a new message when it finishes; do not review the change yourself and do not wait for it.",
					},
				],
				details: request,
				// 这一轮到此为止：接着往下说的模型多半会自己动手审，那正是要避开的。
				terminate: true,
			};
		},
	};
}

export interface ReviewStartDeps {
	/** The conversation that called, live: its meta, its history and where it runs right now. Absent when it is gone. */
	source(sessionId: string): { meta: SessionMeta; messages: readonly Message[]; cwd: string } | undefined;
	/**
	 * Its whole stored history, compacted turns included; null when the store has none.
	 *
	 * The plan and the person's words are read from here, not from the live `messages`: compaction replaces
	 * the early turns there with a summary, and the first to go is the person's original request — the
	 * one thing a reviewer of a long conversation most needs.
	 */
	history(sessionId: string): Promise<readonly Message[] | null>;
	settings(): Settings;
	/** Create the session with this first message and start its first turn. */
	start(input: { parent: SessionMeta; toolCallId: string; cwd: string; modelId: string; title: string; prompt: string }): Promise<void>;
	/** It did not start: the calling turn has already ended on "handed off", so the person has to be told. */
	failed(parentId: string, message: string): void;
	/** The implementing conversation has said which findings to fix: let this review session edit files (`REVIEW_FIX_KEY`). */
	allowFixes(sessionId: string): void;
}

/** 审阅会话问原会话的那两件工具：问一次，或者问过没等完、接着等。 */
const ASKS = new Set(["ask_session", "wait_for_session"]);

export function startReviewSessions(deps: ReviewStartDeps): { observe(sessionId: string, event: AgentEvent): void } {
	// 一次调用只开一个会话。
	const started = new Set<string>();
	return {
		observe(sessionId, event) {
			if (event.type !== "tool_end" || event.isError) return;
			/*
			 * 第 F 步：审阅会话问原会话修哪几条，拿到回答就放行写文件。只认问的是原会话、而且等到了回答
			 * （`done`）：对方在等它的人回答（`blocked`）、超时都还不算——修什么还没定。
			 */
			if (ASKS.has(event.toolName)) {
				const parent = deps.source(sessionId)?.meta.spawnedFrom;
				const outcome = event.result.details as { kind?: unknown; to?: unknown } | undefined;
				if (parent?.review && outcome?.kind === "done" && typeof outcome.to === "string" && outcome.to.endsWith(`[${peerRef(parent.sessionId)}]`)) deps.allowFixes(sessionId);
				return;
			}
			if (event.toolName !== REVIEW_SESSION_TOOL || started.has(event.toolCallId)) return;
			const details = event.result.details as ReviewSessionDetails | undefined;
			if (details?.kind !== "review_session") return;
			const source = deps.source(sessionId);
			if (!source) return;
			started.add(event.toolCallId);
			void (async () => {
				// 存储里读不到（不该发生）才退回眼下的历史：少几条早期原话，也比开不出审阅好。
				const history = (await deps.history(sessionId)) ?? source.messages;
				const plan = latestApprovedPlan(history);
				const prompt = reviewPrompt(details, plan ? renderPlan(plan) : null, history, source.meta.title, peerAddress({ id: source.meta.id, title: source.meta.title, cwd: source.cwd }));
				await deps.start({
					parent: source.meta,
					toolCallId: event.toolCallId,
					// 和原会话完全相同的目录：在工作树里就是那棵工作树，未提交的改动只在那里。
					cwd: source.cwd,
					modelId: reviewModelId(deps.settings(), source.meta.modelId),
					title: details.title,
					prompt,
				});
			})().catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				deps.failed(sessionId, nativeText("review.failed", { reason }));
			});
		},
	};
}
