export { normalizeRetryPolicy } from "./config/retry-policy.ts";
export { bootHostKernel, type HostKernel } from "./kernel/host.ts";
export { registerDefaultSearchProviders } from "./search/defaults.ts";
export { primeCommandPath } from "./sandbox/index.ts";
/** 登录 shell 的环境——MCP 服务就在这份环境里启动，「这个变量有没有设」也要问它。 */
export { commandEnv } from "./sandbox/login-path.ts";
export { useSandboxRunner } from "./sandbox/index.ts";
export type { ReplyTiming, SessionStorage } from "./session/storage.ts";
export { emptyReplayRow, foldUsageRecord, newUsageReplayState, REPLAY_NUMBERS, type UsageReplayRow, type UsageReplayState } from "./session/usage-replay.ts";
export { SessionDbUnavailable } from "./session/db.ts";
export type { SpendRow } from "./session/spend.ts";
export {
	forkAfterMessage,
	forkBeforeMessage,
	readTrajectory,
	TrajectoryReader,
	type Entry as TrajectoryEntry,
	type TrajectoryChanges,
} from "./trajectory/index.ts";
export { isDue } from "./config/schedule.ts";
export { backgroundJobs } from "./tools/background-jobs.ts";
export { streamAssistant } from "./ai/index.ts";
export { sessionHeaders } from "./ai/cache-routing.ts";
export { USER_AGENT } from "./ai/endpoint.ts";
export type { AgentEvent, CommandRun, CompactCode, HookRun, NoticeCode, NoticeParams, QueuedTask } from "./agent/events.ts";
export type { TodoItem } from "./tools/todo.ts";
export { textResult } from "./agent/tool-run.ts";
export { errorResult } from "./tools/result.ts";
/** 一个会话算在哪些目录里；桌面端判断两个会话能不能互相通信时用。 */
export { projectRootsFor } from "./config/project-roots.ts";
export {
	DEFAULT_APPEARANCE,
	DEFAULT_SETTINGS,
	loadSettings,
	rememberProviderNames,
	resolveModel,
	saveSettings,
	settingsPath,
	type AppearanceSettings,
	type ChatBackgroundEffect,
	type PermissionMode,
	type ScheduledTask,
	type ProjectEntry,
	type ScreenshotSettings,
	type Settings,
	type UiLocale,
} from "./config/settings.ts";
/**
 * The credential store, for the desktop's own secrets.
 *
 * Exported from the root because the main process is the only thing that touches it — the renderer
 * never sees a token, which is the point of it living behind IPC.
 */
export { resetVault, seal, unseal } from "./config/vault.ts";
/** Replacing a file whole, for the main process's own files; see `utils/atomic-write.ts`. */
export { renameWithRetry, writeFileAtomic } from "./utils/atomic-write.ts";
/** The HTTP client's own timeouts, installed by each host at startup; see `utils/sse.ts`. */
export { TRANSPORT_TIMEOUT_MS } from "./utils/sse.ts";
export {
	McpManager,
	type McpServerConfig,
	type McpServerStatus,
} from "./mcp/client.ts";
/** 远程 MCP 服务器的 OAuth：后台连接用的令牌、桌面端「登录 / 退出登录」。见 `mcp/oauth.ts`。 */
export { forgetTokens, usesOAuth } from "./mcp/oauth.ts";
export { loginMcpServer } from "./mcp/oauth-login.ts";
export {
	isPlaceholder,
	missingFor,
	needsOf,
	type McpNeed,
} from "./mcp/placeholders.ts";
export {
	bundleRoot,
	fetchRegistry,
	installEntry,
	uninstallEntry,
	type BundleKind,
	type ClientId,
	type Installed,
	type Registry,
	type RegistryEntry,
} from "./plugins/registry.ts";
export {
	loadPlugins,
	type McpBundle,
	type Plugin,
	type PluginDiagnostic,
} from "./plugins/loader.ts";
/*
 * `isOutdated` is also published as `@plume/core/install-record`, and the renderer must use that one.
 * Importing a *value* from this index pulls the whole of it into a browser bundle, which reaches
 * `node:fs` and blanks the window. The type is free either way.
 */
export { isOutdated, readInstalls, type InstallRecord } from "./plugins/installs.ts";
export {
	buildIndex,
	indexStats,
	loadIndex,
	pruneIndexes,
	saveIndex,
	searchIndex,
} from "./index/symbols.ts";
export {
	addMemoryEntry,
	clearAllMemory,
	loadMemory,
	removeMemoryEntry,
} from "./runtime/memory/memory.ts";
export type { ContextBreakdown, ContextSegmentKey } from "./runtime/record/context.ts";
export { restated } from "./reply-text.ts";
export { costAtRates, selectPricingRates, type SelectedPricingRates } from "./utils/pricing.ts";
export {
	diagnoseRequest,
	markCacheBoundary,
	newCacheDiagnosisState,
	type CacheCause,
	type CacheDiagnosisState,
} from "./runtime/record/cache-diagnostics.ts";
export {
	addHook,
	hookEntries,
	readProjectHooks,
	removeHook,
	setHookEnabled,
	updateHook,
	writeProjectHooks,
	type HookDraft,
	type HookEntry,
	type HookEventName,
	type HookScope,
	type HooksConfig,
	type SessionEndReason,
} from "./hooks/config.ts";
export { trustHookDigests, trustedHookDigests } from "./hooks/trust.ts";
export { AgentSession, type AgentSessionOptions } from "./runtime/agent-session/session.ts";
export { summarizeSession } from "./runtime/summary/session-summary.ts";
export {
	plumeHome,
	projectIdFor,
	SessionStore,
	type SessionMeta,
	type SessionRecord,
} from "./session/store.ts";
export type { SpawnedFrom } from "./session/types.ts";
export {
	INLINE_IMAGE_CHARS,
	persistSessionImage,
	safeMediaName,
	sessionMediaHome,
	sessionMediaPath,
} from "./session/payload.ts";
export type { BuiltinCommand } from "./commands/builtin.ts";
export { listCommands, type CommandsList, type SkillEntry } from "./commands/catalogue.ts";
export { resolveInvocation } from "./commands/invoke.ts";
export { bindPromptArguments, findPrompt, type McpPromptEntry } from "./commands/mcp-prompt.ts";
export {
	commandSources,
	loadCommands,
	type SlashCommand,
} from "./commands/loader.ts";
export {
	parseInvocation,
	parseSkillMention,
} from "./commands/expand.ts";
export { loadSkills, isUnparsable, parseFrontmatter, type Skill, type SkillDiagnostic } from "./skills/loader.ts";
export { skillTool } from "./skills/tool.ts";
/*
 * 工具与平台这两处从 `export *` 改成点名。
 *
 * `export *` 的代价不是体积，是「加一个导出不需要经过任何人」——而这个文件是根入口，进来的东西
 * 会被渲染进程当成公共 API 用，而渲染进程从根入口取**值**会把整条 `node:fs` 链拉进浏览器包
 * （见 `.dependency-cruiser.cjs` 里那条规则，以及它注明的「先看到过一整屏空白」）。点名之后，
 * 往外开一个口子是一次要写进 diff 的动作。
 *
 * `./types.ts` 留着 `export *`，它不是同一件事：那个文件自己就是类型模型的门（三行转出三个
 * 类型文件），而类型在编译期就擦掉了，不可能被误当成值拉进包里。
 */
export {
	builtinTools,
	useToolRegistry,
	formatDiff,
	globTool,
	grepTool,
	lsTool,
	readTool,
	BUILTIN_AGENTS,
	usePreviewInspector,
	readLocalPage,
	readLocalPageFor,
	type PreviewInspection,
	type DiffHunk,
} from "./tools/index.ts";
// 不在 git 仓库里走目录时跳过哪些目录：桌面端找回复里的文件也照这张走。
export { SKIP_DIRS } from "./tools/project-files.ts";
// Every risk rule's code with its own wording — what a host's translations of `risk.<code>` cover.
export { RISK_REASONS } from "./tools/risk-reasons.ts";
export { within, withinOrIs } from "./platform.ts";
export * from "./types.ts";
export {
	pruneSessionArtifacts,
	previewsHome,
	removeSessionArtifacts,
	writePreview,
} from "./runtime/policy/previews.ts";

export type { SubAgentDetail } from "./runtime/sub-agent/sub-agents.ts";
export type { SubAgentStatus, SubAgentSummary } from "./types/sub-agent.ts";
export { collectSkills, disabledSkillMatcher } from "./runtime/setup/session-setup.ts";
export {
	approveSkill,
	pendingSkills,
	rejectSkill,
	type SkillCandidate,
} from "./runtime/memory/managed-skills.ts";
export {
	thinkingOptionsFor,
	THINKING_LEVELS,
} from "./ai/thinking-options.ts";
export { lastPassAt, runMemoryPass, shouldRunPass } from "./runtime/memory/memory-pass.ts";
export { resolveModelRef } from "./config/model-choice.ts";
export { isImageModel } from "./config/image-models.ts";
export { generateImages } from "./images/generate.ts";
export { imageDimensions } from "./images/dimensions.ts";
export type { ImageGenerateDetails } from "./images/types.ts";
export { GalleryReader, type Gallery, type GalleryInput, type GalleryPicture, type GallerySession } from "./images/gallery.ts";
export { layerOverrides, loadProjectLayer, projectConfigPath, type ConfigProblem, type LayerOverride } from "./config/layers.ts";
export { annotateInjected, EXTRACTED_KEY, projectInjectedPath, readInjected, userInjectedPath } from "./runtime/memory/memory-injected.ts";
export { readLessons } from "./runtime/memory/project-memory.ts";
export { forgetAllLessons, forgetExtractedMemory, forgetLesson } from "./runtime/memory/project-memory.ts";
export { readExtractedMemory } from "./runtime/memory/memory-extract.ts";
export { projectMemoryDir } from "./runtime/memory/project-memory.ts";
export { computeDiff } from "./tools/diff.ts";

export { readFileChange, undoFileChangeBatches, type RecordedChange } from "./tools/file-changes.ts";
export { AgentDefinitionStore } from "./agents/definition-store.ts";
export type { AgentDraft, AgentDefinitionRecord, AgentDefinitionSave } from "./agents/definition-document.ts";

/*
 * 一份文档里的字。
 *
 * `read` 工具靠它把 `.docx`、`.xlsx`、`.pptx`、`.pdf` 读成字而不是拒掉——这些格式底下是 zip 加 XML，
 * 字就在里面。桌面端把同一份实现用在「拖进输入框」那条路上：同一份文件、同样的字节，不该因为是谁在
 * 问而给出两种答案。
 */
export { extractDocumentText, type ExtractedText } from "./files/document-text.ts";
