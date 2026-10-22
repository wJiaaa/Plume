/**
 * What every host does before its first session: build the kernel and point the runtime at it.
 *
 * The window and the terminal both run this. Written once because the list of seams is the kind of thing that drifts — a seam
 * added here and forgotten in a second copy shows up as a feature that works in one host only.
 */

import { useLlmRegistry } from "../ai/index.ts";
import { useAgentLoop, type AgentLoop } from "../agent/runner.ts";
import type { Settings } from "../config/settings.ts";
import { useApprovalPolicy } from "../runtime/approval-policy.ts";
import { useCompaction } from "../runtime/compaction/compaction.ts";
import { useScheduler } from "../runtime/scheduling.ts";
import { useTurnPipeline } from "../runtime/turn.ts";
import { useSandbox } from "../sandbox/index.ts";
import { duckDuckGoProvider } from "../search/duckduckgo.ts";
import { registerSearchProvider } from "../search/index.ts";
import { instantAnswerProvider } from "../search/instant.ts";
import {
	BRAVE_PROVIDER_ID,
	DEEPSEEK_PROVIDER_ID,
	EXA_PROVIDER_ID,
	keyedSearchProvider,
	TAVILY_PROVIDER_ID,
} from "../search/keyed.ts";
import type { SessionStorage } from "../session/storage.ts";
import { useSkillRegistry } from "../skills/registry.ts";
import { useToolRegistry } from "../tools/index.ts";
import type { Context } from "./context.ts";
import { createContext, DEFAULT_PLUGINS } from "./index.ts";
import {
	APPROVAL,
	COMPACTION,
	LLM,
	LOOP,
	SANDBOX,
	SCHEDULER,
	SESSION,
	SKILLS,
	STORAGE,
	TOOLS,
	type ApprovalPolicy,
	type CompactionStrategy,
	type LlmRegistry,
	type Sandbox,
	type SkillRegistry,
	type TaskScheduler,
	type ToolRegistry,
	type TurnPipeline,
} from "./services.ts";

export interface HostKernel {
	context: Context;
	/** The session store a plugin may have replaced. Hosts build their sessions on this one. */
	storage: SessionStorage;
	skills: SkillRegistry;
	/** Unwinds every seam, then the plugins, in the reverse of the order they arrived. */
	dispose(): Promise<void>;
}

/**
 * One host per process, enforced rather than assumed.
 *
 * The seams below are module-level: a second host would silently re-point sessions already running
 * under the first, and disposing either would unbind both. Moving the seams onto the context is the
 * fix if a process ever needs two; until then, booting a second one is an error, not a surprise.
 */
let booted = false;

export async function bootHostKernel(): Promise<HostKernel> {
	if (booted) throw new Error("bootHostKernel: a host is already running in this process; dispose it first.");
	booted = true;
	try {
		return await boot();
	} catch (error) {
		booted = false;
		throw error;
	}
}

async function boot(): Promise<HostKernel> {
	const context = await createContext(DEFAULT_PLUGINS);
	const skills = context.require<SkillRegistry>(SKILLS);
	useLlmRegistry(context.require<LlmRegistry>(LLM));
	useToolRegistry(context.require<ToolRegistry>(TOOLS));
	useSandbox(context.require<Sandbox>(SANDBOX));
	useCompaction(context.require<CompactionStrategy>(COMPACTION));
	useApprovalPolicy(context.require<ApprovalPolicy>(APPROVAL));
	useSkillRegistry(skills);
	useScheduler(context.require<TaskScheduler>(SCHEDULER));
	useAgentLoop(context.require<AgentLoop>(LOOP));
	useTurnPipeline(context.require<TurnPipeline>(SESSION).middleware);
	let disposed = false;
	return {
		context,
		storage: context.require<SessionStorage>(STORAGE),
		skills,
		async dispose() {
			// A second dispose of this host must not unbind a host booted since.
			if (disposed) return;
			disposed = true;
			useLlmRegistry(null);
			useToolRegistry(null);
			useSandbox(null);
			useCompaction(null);
			useApprovalPolicy(null);
			useSkillRegistry(null);
			useScheduler(null);
			useAgentLoop(null);
			useTurnPipeline(null);
			booted = false;
			await context.dispose();
		},
	};
}

/**
 * Search, working out of the box.
 *
 * The keyless provider is registered unconditionally so a fresh install can search at all; the
 * keyed ones read their key at call time, so they become available the moment one is pasted in
 * and stay out of the way until then. Which of them runs is `selectSearchProvider`'s call: the
 * user's pick, or — with none made — a pasted key over the keyless default.
 */
export function registerDefaultSearchProviders(keys: () => Settings["searchApiKeys"]): void {
	registerSearchProvider(duckDuckGoProvider());
	registerSearchProvider(instantAnswerProvider());
	registerSearchProvider(keyedSearchProvider(TAVILY_PROVIDER_ID, () => keys()?.tavily));
	registerSearchProvider(keyedSearchProvider(EXA_PROVIDER_ID, () => keys()?.exa));
	registerSearchProvider(keyedSearchProvider(BRAVE_PROVIDER_ID, () => keys()?.brave));
	registerSearchProvider(keyedSearchProvider(DEEPSEEK_PROVIDER_ID, () => keys()?.deepseek));
}
