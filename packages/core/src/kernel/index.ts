import { Context } from "./context.ts";
import { approvalPlugin } from "./plugins/approval.ts";
import { compactionPlugin } from "./plugins/compaction.ts";
import { llmPlugin } from "./plugins/llm.ts";
import { loopPlugin } from "./plugins/loop.ts";
import { sandboxPlugin } from "./plugins/sandbox.ts";
import { schedulerPlugin } from "./plugins/scheduler.ts";
import { sessionPlugin } from "./plugins/session.ts";
import { skillsPlugin } from "./plugins/skills.ts";
import { storagePlugin } from "./plugins/storage.ts";
import { toolsPlugin } from "./plugins/tools.ts";

export { Context } from "./context.ts";
export {
	COMPACTION,
	EVENTS,
	LLM,
	LOOP,
	SANDBOX,
	SCHEDULER,
	SESSION,
	SKILLS,
	STORAGE,
	TOOLS,
	type CompactionStrategy,
	type LlmRegistry,
	type Sandbox,
	type SandboxProcess,
	type SkillRegistry,
	type TaskScheduler,
	type TurnPipeline,
	type ToolRegistry,
} from "./services.ts";

/**
 * The set that makes an ordinary Plume.
 *
 * Listed rather than discovered, because the default configuration should be something you can
 * read. A host that wants a different shape — no shell, a remote sandbox, another model API —
 * builds its own list instead of passing flags to this one.
 */
export const DEFAULT_PLUGINS = [llmPlugin, toolsPlugin, approvalPlugin, sandboxPlugin, compactionPlugin, skillsPlugin, storagePlugin, schedulerPlugin, sessionPlugin, loopPlugin];

/**
 * Build a context with a given set of plugins.
 *
 * Applied in array order; the built-in set goes first so every seam exists before anything that
 * might use it.
 */
export async function createContext(plugins = DEFAULT_PLUGINS): Promise<Context> {
	const ctx = new Context();
	for (const plugin of plugins) await ctx.use(plugin);
	return ctx;
}
